/**
 * Unit tests for ConvergenceDetector.
 *
 * Pure logic — no browser dependencies.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConvergenceDetector } from '../../src/convergence.js';

describe('ConvergenceDetector', () => {
  function makeGains(values) {
    return new Float32Array(values);
  }

  test('returns not converged with delta=0 when only 1 window stored', () => {
    const det = new ConvergenceDetector(0.5, 3);
    const result = det.push(makeGains([0, 0, 0]));
    assert.equal(result.converged, false);
    assert.equal(result.delta, 0);
  });

  test('computes correct delta between two windows', () => {
    const det = new ConvergenceDetector(0.5, 3);
    det.push(makeGains([0, 0, 0]));
    const result = det.push(makeGains([1, 1, 1]));
    assert.equal(result.delta, 1);
    assert.equal(result.converged, false);
  });

  test('converges after windowCount-1 consecutive stable comparisons', () => {
    const det = new ConvergenceDetector(0.5, 3);
    // Window 1
    det.push(makeGains([0, 0, 0]));
    // Window 2 — delta = 0.1 (below threshold)
    det.push(makeGains([0.1, 0.1, 0.1]));
    // Window 3 — delta = 0.05 (below threshold), 2 consecutive stable = windowCount-1
    const result = det.push(makeGains([0.15, 0.15, 0.15]));
    assert.equal(result.converged, true);
    assert.ok(result.delta < 0.5);
  });

  test('does not converge if delta exceeds threshold', () => {
    const det = new ConvergenceDetector(0.5, 3);
    det.push(makeGains([0, 0, 0]));
    det.push(makeGains([0.1, 0.1, 0.1]));
    // Large jump — breaks the streak
    const result = det.push(makeGains([2, 2, 2]));
    assert.equal(result.converged, false);
    assert.ok(Math.abs(result.delta - 1.9) < 0.001);
  });

  test('does not converge with transient low delta (requires consecutive)', () => {
    const det = new ConvergenceDetector(0.5, 3);
    det.push(makeGains([0, 0, 0]));
    // delta = 0.1 (stable)
    det.push(makeGains([0.1, 0.1, 0.1]));
    // delta = 1.0 (unstable — breaks streak)
    det.push(makeGains([1.1, 1.1, 1.1]));
    // delta = 0.1 (stable again, but only 1 consecutive)
    const result = det.push(makeGains([1.2, 1.2, 1.2]));
    assert.equal(result.converged, false);
  });

  test('reset clears all stored windows', () => {
    const det = new ConvergenceDetector(0.5, 3);
    det.push(makeGains([0, 0, 0]));
    det.push(makeGains([0.1, 0.1, 0.1]));
    det.reset();
    const result = det.push(makeGains([0, 0, 0]));
    assert.equal(result.converged, false);
    assert.equal(result.delta, 0); // back to single-window state
  });

  test('windowCount property reflects stored windows', () => {
    const det = new ConvergenceDetector(0.5, 3);
    assert.equal(det.windowCount, 0);
    det.push(makeGains([0, 0, 0]));
    assert.equal(det.windowCount, 1);
    det.push(makeGains([0.1, 0.1, 0.1]));
    assert.equal(det.windowCount, 2);
  });

  test('trims windows to windowCount maximum', () => {
    const det = new ConvergenceDetector(0.5, 3);
    det.push(makeGains([0, 0, 0]));
    det.push(makeGains([0.1, 0.1, 0.1]));
    det.push(makeGains([0.15, 0.15, 0.15]));
    det.push(makeGains([0.2, 0.2, 0.2]));
    assert.equal(det.windowCount, 3); // capped at windowCount
  });

  test('default constructor uses threshold=0.5 and windowCount=3', () => {
    const det = new ConvergenceDetector();
    det.push(makeGains([0, 0, 0]));
    det.push(makeGains([0.1, 0.1, 0.1]));
    const result = det.push(makeGains([0.15, 0.15, 0.15]));
    assert.equal(result.converged, true);
  });

  test('custom threshold is respected', () => {
    const det = new ConvergenceDetector(0.1, 3);
    det.push(makeGains([0, 0, 0]));
    det.push(makeGains([0.05, 0.05, 0.05]));
    const result = det.push(makeGains([0.08, 0.08, 0.08]));
    // delta = 0.03 < 0.1 threshold, 2 consecutive stable
    assert.equal(result.converged, true);
  });

  test('handles large gain arrays (realistic 147-band scenario)', () => {
    const det = new ConvergenceDetector(0.5, 3);
    const bandCount = 147;
    const gains1 = makeGains(Array(bandCount).fill(0));
    const gains2 = makeGains(Array(bandCount).fill(0.2));
    const gains3 = makeGains(Array(bandCount).fill(0.25));

    det.push(gains1);
    det.push(gains2);
    const result = det.push(gains3);
    assert.ok(Math.abs(result.delta - 0.05) < 0.001);
    assert.equal(result.converged, true);
  });

  // Phase 2: minMeasurements gate
  test('minMeasurements blocks convergence until threshold reached', () => {
    const det = new ConvergenceDetector(0.5, 3, 4);
    // Push 4 windows — all stable but validPushCount < minMeasurements for first 3
    det.push(makeGains([0, 0, 0]));          // push 1: validPushCount=1
    det.push(makeGains([0.1, 0.1, 0.1]));    // push 2: validPushCount=2
    det.push(makeGains([0.15, 0.15, 0.15])); // push 3: validPushCount=3, blocked (< 4)
    const r3 = det.push(makeGains([0.15, 0.15, 0.15])); // push 4: validPushCount=4, now allowed
    // At push 4: validPushCount=4 >= minMeasurements=4, convergence IS allowed
    assert.equal(r3.converged, true);
    assert.ok(r3.delta < 0.5);

    // Verify that with minMeasurements=5, push 4 would still be blocked
    const det2 = new ConvergenceDetector(0.5, 3, 5);
    det2.push(makeGains([0, 0, 0]));
    det2.push(makeGains([0.1, 0.1, 0.1]));
    det2.push(makeGains([0.15, 0.15, 0.15]));
    det2.push(makeGains([0.15, 0.15, 0.15]));
    const r4 = det2.push(makeGains([0.15, 0.15, 0.15])); // push 5: validPushCount=5 >= 5
    assert.equal(r4.converged, true);

    // Verify push 4 with minMeasurements=5 is blocked
    const det3 = new ConvergenceDetector(0.5, 3, 5);
    det3.push(makeGains([0, 0, 0]));
    det3.push(makeGains([0.1, 0.1, 0.1]));
    det3.push(makeGains([0.15, 0.15, 0.15]));
    const rBlocked = det3.push(makeGains([0.15, 0.15, 0.15])); // push 4: validPushCount=4 < 5
    assert.equal(rBlocked.converged, false);
  });

  test('minMeasurements=0 (default) preserves backward compatibility', () => {
    const det = new ConvergenceDetector(0.5, 3, 0);
    det.push(makeGains([0, 0, 0]));
    det.push(makeGains([0.1, 0.1, 0.1]));
    const result = det.push(makeGains([0.15, 0.15, 0.15]));
    assert.equal(result.converged, true);
  });

  test('reset clears validPushCount', () => {
    const det = new ConvergenceDetector(0.5, 3, 4);
    det.push(makeGains([0, 0, 0]));
    det.push(makeGains([0.1, 0.1, 0.1]));
    det.reset();
    // After reset, push 3 more — validPushCount=3 < minMeasurements=4
    det.push(makeGains([0, 0, 0]));
    det.push(makeGains([0.1, 0.1, 0.1]));
    const r = det.push(makeGains([0.15, 0.15, 0.15]));
    assert.equal(r.converged, false); // only 3 valid pushes after reset, need 4
  });

  test('convergence requires both minMeasurements AND stable windows', () => {
    const det = new ConvergenceDetector(0.5, 3, 4);
    // Push 4 windows but NOT stable (large deltas)
    det.push(makeGains([0, 0, 0]));
    det.push(makeGains([2, 2, 2]));
    det.push(makeGains([0, 0, 0]));
    det.push(makeGains([2, 2, 2]));
    const r = det.push(makeGains([0, 0, 0]));
    assert.equal(r.converged, false); // minMeasurements met but not stable
  });
});
