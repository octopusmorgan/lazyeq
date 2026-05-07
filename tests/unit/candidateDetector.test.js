/**
 * Unit tests for candidateDetector.
 *
 * Pure logic — no browser dependencies.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectCandidates } from '../../src/candidateDetector.js';

describe('detectCandidates', () => {
  /**
   * Create logarithmically spaced frequencies from fLow to fHigh.
   */
  function logFreqs(count, fLow = 20, fHigh = 20000) {
    const freqs = [];
    const logLow = Math.log10(fLow);
    const logHigh = Math.log10(fHigh);
    for (let i = 0; i < count; i++) {
      freqs.push(Math.pow(10, logLow + (logHigh - logLow) * i / (count - 1)));
    }
    return freqs;
  }

  /**
   * Create a flat response and target (both 0 dB).
   */
  function flatData(count = 64) {
    const freqs = logFreqs(count);
    return {
      response: new Float32Array(count),
      target: new Float32Array(count),
      frequencies: freqs,
    };
  }

  /**
   * Create response with a peak at a specific frequency.
   */
  function peakData(peakFreq, peakDb, count = 64, widthOctaves = 1) {
    const freqs = logFreqs(count);
    const response = new Float32Array(count);
    const target = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const f = freqs[i];
      const octDiff = Math.log2(f / peakFreq);
      if (Math.abs(octDiff) < widthOctaves) {
        // Gaussian-like peak
        const envelope = Math.exp(-0.5 * (octDiff / (widthOctaves / 2)) ** 2);
        response[i] = peakDb * envelope;
      }
    }

    return { response, target, frequencies: freqs };
  }

  /**
   * Create response with a null (dip) at a specific frequency.
   */
  function nullData(nullFreq, nullDb, count = 64, widthOctaves = 1) {
    const freqs = logFreqs(count);
    const response = new Float32Array(count);
    const target = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const f = freqs[i];
      const octDiff = Math.log2(f / nullFreq);
      if (Math.abs(octDiff) < widthOctaves) {
        const envelope = Math.exp(-0.5 * (octDiff / (widthOctaves / 2)) ** 2);
        response[i] = nullDb * envelope; // negative value
      }
    }

    return { response, target, frequencies: freqs };
  }

  test('happy path: detects 3 clear peaks at known frequencies', () => {
    const freqs = logFreqs(64);
    const response = new Float32Array(64);
    const target = new Float32Array(64);

    // Add 3 peaks at approximate frequencies
    // Peak 1: ~80 Hz
    // Peak 2: ~500 Hz
    // Peak 3: ~2000 Hz
    for (let i = 0; i < 64; i++) {
      const f = freqs[i];
      // Peak at 80 Hz
      const d1 = Math.log2(f / 80);
      response[i] += 4 * Math.exp(-0.5 * (d1 / 0.5) ** 2);
      // Peak at 500 Hz
      const d2 = Math.log2(f / 500);
      response[i] += 3 * Math.exp(-0.5 * (d2 / 0.5) ** 2);
      // Peak at 2000 Hz
      const d3 = Math.log2(f / 2000);
      response[i] += 3.5 * Math.exp(-0.5 * (d3 / 0.5) ** 2);
    }

    const candidates = detectCandidates(response, target, freqs, {
      effectiveRange: { low: 20, high: 20000 },
    });

    assert.ok(candidates.length >= 3, `Expected at least 3 candidates, got ${candidates.length}`);
    assert.ok(candidates.every((c) => c.type === 'peak'), 'All should be peaks');

    // Check that detected frequencies are close to expected
    const detectedFreqs = candidates.map((c) => c.freq).sort((a, b) => a - b);
    assert.ok(Math.abs(detectedFreqs[0] - 80) < 30, `First peak freq ${detectedFreqs[0]} should be near 80`);
    assert.ok(Math.abs(detectedFreqs[1] - 500) < 100, `Second peak freq ${detectedFreqs[1]} should be near 500`);
    assert.ok(Math.abs(detectedFreqs[2] - 2000) < 400, `Third peak freq ${detectedFreqs[2]} should be near 2000`);
  });

  test('flat response: response equals target → empty candidates', () => {
    const { response, target, frequencies } = flatData(64);
    const candidates = detectCandidates(response, target, frequencies);
    assert.deepEqual(candidates, []);
  });

  test('narrow null rejection: null narrower than 1/3 octave is rejected', () => {
    // Create a very narrow null at 1000 Hz (width < freq/3 = 333 Hz)
    const freqs = logFreqs(64);
    const response = new Float32Array(64);
    const target = new Float32Array(64);

    // Very narrow null: only affects 1-2 points
    for (let i = 0; i < 64; i++) {
      const f = freqs[i];
      const octDiff = Math.log2(f / 1000);
      // Very narrow: 0.1 octave width
      response[i] = -3 * Math.exp(-0.5 * (octDiff / 0.05) ** 2);
    }

    const candidates = detectCandidates(response, target, freqs);

    // The null should be rejected because it's narrower than freq/3
    const nulls = candidates.filter((c) => c.type === 'null');
    assert.ok(nulls.length === 0, `Narrow null should be rejected, got ${nulls.length} nulls`);
  });

  test('merge nearby candidates: two peaks within 1/6 octave merge into one', () => {
    const freqs = logFreqs(64);
    const response = new Float32Array(64);
    const target = new Float32Array(64);

    // Two peaks very close together at ~500 Hz (within 1/6 octave ≈ 12% apart)
    // 500 Hz * 2^(1/12) ≈ 530 Hz
    for (let i = 0; i < 64; i++) {
      const f = freqs[i];
      const d1 = Math.log2(f / 500);
      response[i] += 4 * Math.exp(-0.5 * (d1 / 0.3) ** 2);
      const d2 = Math.log2(f / 530);
      response[i] += 3 * Math.exp(-0.5 * (d2 / 0.3) ** 2);
    }

    const candidates = detectCandidates(response, target, freqs);
    const peaks = candidates.filter((c) => c.type === 'peak');

    // Should be merged into one
    assert.ok(peaks.length <= 1, `Expected 1 merged peak, got ${peaks.length}`);
  });

  test('peak and null: detects both types in same response', () => {
    const freqs = logFreqs(64);
    const response = new Float32Array(64);
    const target = new Float32Array(64);

    // Peak at 200 Hz
    for (let i = 0; i < 64; i++) {
      const f = freqs[i];
      const dp = Math.log2(f / 200);
      response[i] += 4 * Math.exp(-0.5 * (dp / 0.5) ** 2);
      // Null at 2000 Hz
      const dn = Math.log2(f / 2000);
      response[i] -= 3 * Math.exp(-0.5 * (dn / 0.5) ** 2);
    }

    const candidates = detectCandidates(response, target, freqs);

    const peaks = candidates.filter((c) => c.type === 'peak');
    const nulls = candidates.filter((c) => c.type === 'null');

    assert.ok(peaks.length >= 1, 'Should detect at least 1 peak');
    assert.ok(nulls.length >= 1, 'Should detect at least 1 null');
  });

  test('edge frequencies: peak at lowest frequency is detected', () => {
    const freqs = logFreqs(64);
    const response = new Float32Array(64);
    const target = new Float32Array(64);

    // Peak at lowest frequency
    response[0] = 5;
    response[1] = 3;
    response[2] = 1;

    const candidates = detectCandidates(response, target, freqs, {
      effectiveRange: { low: 20, high: 20001 },
    });
    const edgePeaks = candidates.filter((c) => c.atIndex === 0);

    assert.ok(edgePeaks.length >= 1, 'Should detect peak at edge (index 0)');
  });

  test('edge frequencies: peak at highest frequency is detected', () => {
    const freqs = logFreqs(64);
    const response = new Float32Array(64);
    const target = new Float32Array(64);

    // Peak at highest frequency
    const last = freqs.length - 1;
    response[last] = 5;
    response[last - 1] = 3;
    response[last - 2] = 1;

    const candidates = detectCandidates(response, target, freqs, {
      effectiveRange: { low: 20, high: 20001 },
    });
    const edgePeaks = candidates.filter((c) => c.atIndex === last);

    assert.ok(edgePeaks.length >= 1, 'Should detect peak at edge (last index)');
  });

  test('below threshold: deviations within ±2dB produce no candidates', () => {
    const freqs = logFreqs(64);
    const response = new Float32Array(64);
    const target = new Float32Array(64);

    // Small deviations, all below threshold
    for (let i = 0; i < 64; i++) {
      response[i] = 1.5 * Math.sin(i * 0.5); // oscillates between -1.5 and +1.5
    }

    const candidates = detectCandidates(response, target, freqs);
    assert.deepEqual(candidates, []);
  });

  test('bad input: null/empty arrays return empty candidates', () => {
    assert.deepEqual(detectCandidates(null, new Float32Array(10), [100]), []);
    assert.deepEqual(detectCandidates(new Float32Array(10), null, [100]), []);
    assert.deepEqual(detectCandidates(new Float32Array(0), new Float32Array(0), []), []);
    assert.deepEqual(detectCandidates(undefined, undefined, undefined), []);
  });

  test('bad input: NaN values return empty candidates', () => {
    const response = new Float32Array([1, 2, NaN, 4]);
    const target = new Float32Array([0, 0, 0, 0]);
    const freqs = [100, 200, 300, 400];
    assert.deepEqual(detectCandidates(response, target, freqs), []);
  });

  test('candidate object has correct shape', () => {
    const { response, target, frequencies } = peakData(500, 5, 64, 1);
    const candidates = detectCandidates(response, target, frequencies);

    assert.ok(candidates.length > 0, 'Should detect at least one candidate');
    const c = candidates[0];
    assert.ok(typeof c.freq === 'number', 'freq should be a number');
    assert.ok(typeof c.deviationDb === 'number', 'deviationDb should be a number');
    assert.ok(c.type === 'peak' || c.type === 'null', 'type should be peak or null');
    assert.ok(typeof c.widthHz === 'number', 'widthHz should be a number');
    assert.ok(typeof c.confidence === 'number', 'confidence should be a number');
    assert.ok(typeof c.atIndex === 'number', 'atIndex should be a number');
    assert.ok(c.confidence >= 0 && c.confidence <= 1, 'confidence should be in [0, 1]');
  });

  test('options override default thresholds', () => {
    const freqs = logFreqs(64);
    const response = new Float32Array(64);
    const target = new Float32Array(64);

    // Small peak at 3 dB (below default 2 dB threshold but above custom 1 dB)
    for (let i = 0; i < 64; i++) {
      const f = freqs[i];
      const d = Math.log2(f / 500);
      response[i] = 3 * Math.exp(-0.5 * (d / 0.5) ** 2);
    }

    // With default threshold (2 dB), should detect
    const defaultResult = detectCandidates(response, target, freqs);
    assert.ok(defaultResult.length > 0, 'Should detect with default threshold');

    // With higher threshold (5 dB), should NOT detect
    const highThreshold = detectCandidates(response, target, freqs, { peakThreshold: 5 });
    assert.deepEqual(highThreshold, [], 'Should not detect with 5 dB threshold');
  });
});
