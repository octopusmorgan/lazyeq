/**
 * Unit tests for CalibrationOrchestrator skeleton.
 *
 * Tests constructor DI contract, state accessors, and filter pool updates.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

// --- Mocks ---

class MockBiquadFilter {
  constructor() {
    this.type = 'peaking';
    this.frequency = { value: 1000, setTargetAtTime: (v, t, c) => { this.frequency.value = v; } };
    this.gain = { value: 0, setTargetAtTime: (v, t, c) => { this.gain.value = v; } };
    this.Q = { value: 1.0, setTargetAtTime: (v, t, c) => { this.Q.value = v; } };
    this._connected = [];
  }
  connect(node) { this._connected.push(node); }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
  }
  createBiquadFilter() {
    return new MockBiquadFilter();
  }
}

function buildMinimalDeps() {
  return {
    analyzer: { getLinearFrequencyLabels: () => [] },
    audioContext: new MockAudioContext(),
    pinkNoise: { start: () => {}, stop: () => {}, setFilterChain: () => {} },
    convergence: { push: () => ({ converged: false, delta: 0 }), windowCount: 0 },
    smartCorrection: () => ({ bands: [], gains: null, evalResiduals: new Float32Array(7), maxResidual: 0, pipelineStats: {}, candidates: [] }),
    debugLog: { logWindow: () => {}, logConverged: () => {}, logError: () => {}, enable: () => {} },
  };
}

// --- Tests ---

describe('CalibrationOrchestrator — Skeleton', () => {
  let CalibrationOrchestrator;

  before(async () => {
    CalibrationOrchestrator = (await import('../../src/CalibrationOrchestrator.js')).CalibrationOrchestrator;
  });

  describe('Constructor — DI Contract (R1)', () => {
    test('throws TypeError when analyzer is missing', () => {
      const deps = buildMinimalDeps();
      delete deps.analyzer;
      assert.throws(() => new CalibrationOrchestrator(deps), TypeError);
    });

    test('throws TypeError when audioContext is missing', () => {
      const deps = buildMinimalDeps();
      delete deps.audioContext;
      assert.throws(() => new CalibrationOrchestrator(deps), TypeError);
    });

    test('throws TypeError when pinkNoise is missing', () => {
      const deps = buildMinimalDeps();
      delete deps.pinkNoise;
      assert.throws(() => new CalibrationOrchestrator(deps), TypeError);
    });

    test('throws TypeError when convergence is missing', () => {
      const deps = buildMinimalDeps();
      delete deps.convergence;
      assert.throws(() => new CalibrationOrchestrator(deps), TypeError);
    });

    test('throws TypeError when smartCorrection is missing', () => {
      const deps = buildMinimalDeps();
      delete deps.smartCorrection;
      assert.throws(() => new CalibrationOrchestrator(deps), TypeError);
    });

    test('throws TypeError when debugLog is missing', () => {
      const deps = buildMinimalDeps();
      delete deps.debugLog;
      assert.throws(() => new CalibrationOrchestrator(deps), TypeError);
    });

    test('constructs without error when all required deps provided', () => {
      const deps = buildMinimalDeps();
      const inst = new CalibrationOrchestrator(deps);
      assert.ok(inst instanceof CalibrationOrchestrator);
    });

    test('gracefully degrades when optional callbacks are missing', () => {
      const deps = buildMinimalDeps();
      // No onStatusChange, onRenderFrame, onCalibrationResult → should not throw
      const inst = new CalibrationOrchestrator(deps);
      assert.ok(inst instanceof CalibrationOrchestrator);
    });

    test('stores optional callbacks when provided', () => {
      const deps = buildMinimalDeps();
      const callbacks = {
        onStatusChange: () => {},
        onRenderFrame: () => {},
        onCalibrationResult: () => {},
      };
      const inst = new CalibrationOrchestrator({ ...deps, ...callbacks });
      assert.ok(inst instanceof CalibrationOrchestrator);
    });
  });

  describe('isRunning() — (R6 state contract)', () => {
    test('returns false initially', () => {
      const inst = new CalibrationOrchestrator(buildMinimalDeps());
      assert.equal(inst.isRunning(), false);
    });

    test('returns true when calibration is active', () => {
      const inst = new CalibrationOrchestrator(buildMinimalDeps());
      inst._calibrationRunning = true;
      assert.equal(inst.isRunning(), true);
    });
  });

  describe('getState() — (Design §Class Interface)', () => {
    test('returns object with running, liveVisData, liveEQGains, lastResult', () => {
      const inst = new CalibrationOrchestrator(buildMinimalDeps());
      const state = inst.getState();
      assert.ok(typeof state === 'object');
      assert.equal(state.running, false);
      assert.equal(state.liveVisData, null);
      assert.equal(state.liveEQGains, null);
      assert.equal(state.lastResult, null);
    });

    test('reflects updated internal state', () => {
      const inst = new CalibrationOrchestrator(buildMinimalDeps());
      const visData = [{ x: 100, y: -20 }];
      const gains = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);
      const result = { visData, gains };
      inst._calibrationRunning = true;
      inst._liveVisData = visData;
      inst._liveEQGains = gains;
      inst._lastMeasurementResult = result;
      const state = inst.getState();
      assert.equal(state.running, true);
      assert.equal(state.liveVisData, visData);
      assert.equal(state.liveEQGains, gains);
      assert.equal(state.lastResult, result);
    });
  });

  describe('updateFilterPool()', () => {
    test('does nothing when activeEQFilters is null (no crash)', () => {
      const inst = new CalibrationOrchestrator(buildMinimalDeps());
      inst.updateFilterPool([{ freq: 1000, gain: 3, Q: 2 }]);
      // Should not throw
    });

    test('updates filter parameters when filters exist', () => {
      const filters = Array.from({ length: 16 }, () => new MockBiquadFilter());
      const inst = new CalibrationOrchestrator(buildMinimalDeps());
      // Set filters internally (normally done by start())
      inst._activeEQFilters = filters;

      const bands = [
        { freq: 200, gain: 2, Q: 1.5 },
        { freq: 1000, gain: -1.5, Q: 2 },
      ];

      inst.updateFilterPool(bands);

      // First filter updated
      assert.equal(filters[0].frequency.value, 200);
      assert.equal(filters[0].gain.value, 2);
      assert.equal(filters[0].Q.value, 1.5);

      // Second filter updated
      assert.equal(filters[1].frequency.value, 1000);
      assert.equal(filters[1].gain.value, -1.5);
      assert.equal(filters[1].Q.value, 2);

      // Third filter (no band) gets gain = 0
      assert.equal(filters[2].gain.value, 0);
    });

    test('zeros all filters when bands array is empty', () => {
      const filters = Array.from({ length: 16 }, () => new MockBiquadFilter());
      // Set some initial values
      filters[0].frequency.value = 500;
      filters[5].gain.value = 3;
      const inst = new CalibrationOrchestrator(buildMinimalDeps());
      inst._activeEQFilters = filters;

      inst.updateFilterPool([]);

      // All filters should have gain = 0
      for (let i = 0; i < 16; i++) {
        assert.equal(filters[i].gain.value, 0);
      }
      // Unused filters keep their freq/Q (only gain is reset)
      assert.equal(filters[0].frequency.value, 500);
    });

    test('does nothing when activeEQFilters has wrong length', () => {
      const inst = new CalibrationOrchestrator(buildMinimalDeps());
      inst._activeEQFilters = [new MockBiquadFilter()]; // only 1 filter
      inst.updateFilterPool([{ freq: 1000, gain: 3, Q: 2 }]);
      // Filter should remain unchanged
      assert.equal(inst._activeEQFilters[0].frequency.value, 1000);
    });
  });
});
