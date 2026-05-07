/**
 * Regression tests — verify sweep path exports are unaffected by smart correction changes.
 *
 * Lightweight import/interface smoke test (not full functional — requires browser).
 * Verifies that SineSweepSource and SpectrumAnalyzer are still exported with expected APIs.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('T-3.4: Sweep Path Regression', () => {

  describe('SineSweepSource exports intact', () => {
    test('SineSweepSource is a function/constructor', async () => {
      const { SineSweepSource } = await import('../../src/sineSweep.js');
      assert.ok(typeof SineSweepSource === 'function');
    });

    test('SineSweepSource has expected prototype methods', async () => {
      const { SineSweepSource } = await import('../../src/sineSweep.js');
      assert.ok(typeof SineSweepSource.prototype.createBuffer === 'function');
      assert.ok(typeof SineSweepSource.prototype.start === 'function');
      assert.ok(typeof SineSweepSource.prototype.stop === 'function');
      assert.ok(typeof SineSweepSource.prototype.setVolume === 'function');
    });
  });

  describe('SpectrumAnalyzer exports intact', () => {
    test('SpectrumAnalyzer is a function/constructor', async () => {
      const { SpectrumAnalyzer } = await import('../../src/analyzer.js');
      assert.ok(typeof SpectrumAnalyzer === 'function');
    });

    test('SpectrumAnalyzer has expected prototype methods', async () => {
      const { SpectrumAnalyzer } = await import('../../src/analyzer.js');
      const proto = SpectrumAnalyzer.prototype;
      assert.ok(typeof proto.init === 'function');
      assert.ok(typeof proto.recordSweep === 'function');
      assert.ok(typeof proto.measureContinuous === 'function');
      assert.ok(typeof proto.captureNoiseFloor === 'function');
      assert.ok(typeof proto.getCorrectedSpectrumFromDB === 'function');
      assert.ok(typeof proto.getRMSLevel === 'function');
      assert.ok(typeof proto.destroy === 'function');
    });
  });
});
