/**
 * Unit tests for calibrationDebugLog helpers (pure functions).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sampleDbAtLinearFreq, interpLogFreq } from '../../src/calibrationDebugLog.js';

describe('calibrationDebugLog helpers', () => {
  test('sampleDbAtLinearFreq picks closer bin', () => {
    const labels = [0, 100, 200, 300];
    const spec = new Float32Array([-10, 0, 5, -2]);
    assert.ok(Math.abs(sampleDbAtLinearFreq(spec, labels, 105) - 0) < 0.01);
    assert.ok(Math.abs(sampleDbAtLinearFreq(spec, labels, 195) - 5) < 0.01);
  });

  test('interpLogFreq interpolates in log space', () => {
    const xs = [100, 1000];
    const ys = new Float32Array([0, 10]);
    const mid = interpLogFreq(xs, ys, 316.227766); // sqrt(100*1000)
    assert.ok(Math.abs(mid - 5) < 0.2, `expected ~5, got ${mid}`);
  });
});
