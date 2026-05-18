/**
 * Unit tests for CalibrationOrchestrator — Commit 1: start().
 *
 * Tests constructor DI contract, state accessors, filter pool updates,
 * and the start() lifecycle method.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

// --- Global mocks for Node.js ---

const _store = {};
const localStorageMock = {
  getItem: (key) => _store[key] ?? null,
  setItem: (key, value) => { _store[key] = String(value); },
  removeItem: (key) => { delete _store[key]; },
  clear: () => { for (const k in _store) delete _store[k]; },
  key: (i) => Object.keys(_store)[i] ?? null,
};

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
    this.sampleRate = 44100;
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }
  createBiquadFilter() {
    return new MockBiquadFilter();
  }
  createBuffer(channels, length, sampleRate) {
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length),
    };
  }
  createBufferSource() {
    return {
      buffer: null,
      loop: false,
      connect: () => {},
      disconnect: () => {},
      start: () => {},
      stop: () => {},
    };
  }
}

/**
 * Build minimal required deps for CalibrationOrchestrator.
 */
function buildMinimalDeps() {
  return {
    analyzer: {
      getLinearFrequencyLabels: () => [],
      getCurrentSpectrum: () => new Float32Array(1024).fill(-100),
      getRMSLevel: () => -50,
      getNoiseFloorRMS: () => -90,
      getCorrectedSpectrumFromDB: (s) => s,
      measureContinuous: (cb) => {
        const ctrl = { _cb: cb, _stopped: false };
        ctrl.stop = () => { ctrl._stopped = true; };
        return ctrl;
      },
      destroy: () => {},
    },
    audioContext: new MockAudioContext(),
    processMeasurement: (spectrum) => ({
      visData: [{ x: 100, y: -20 }, { x: 200, y: -15 }, { x: 500, y: -10 }],
      normalizedResponse: new Float32Array([-20, -15, -10]),
      gains: [1, 2, 3],
      rangeAvg: -10,
    }),
  };
}

function buildFullDeps() {
  return {
    ...buildMinimalDeps(),
    onStatusChange: () => {},
    onProgress: () => {},
    onComplete: () => {},
  };
}

// --- Tests ---

describe('CalibrationOrchestrator — Commit 1 (start)', () => {
  let CalibrationOrchestrator;

  /** @type {CalibrationOrchestrator[]} */
  const _instances = [];

  before(async () => {
    globalThis.localStorage = localStorageMock;
    CalibrationOrchestrator = (await import('../../src/CalibrationOrchestrator.js')).CalibrationOrchestrator;
  });

  after(() => {
    // Clean up all outstanding timeouts from tests
    for (const inst of _instances) {
      if (inst._calibrationTimeout) {
        clearTimeout(inst._calibrationTimeout);
        inst._calibrationTimeout = null;
      }
    }
  });

  /** Wrap orchestrator creation to track instances for cleanup */
  function createInst(deps) {
    const inst = new CalibrationOrchestrator(deps);
    _instances.push(inst);
    return inst;
  }

  describe('Constructor — DI Contract', () => {
    test('throws TypeError when analyzer is missing', () => {
      const deps = buildFullDeps();
      delete deps.analyzer;
      assert.throws(() => createInst(deps), TypeError);
    });

    test('throws TypeError when audioContext is missing', () => {
      const deps = buildFullDeps();
      delete deps.audioContext;
      assert.throws(() => createInst(deps), TypeError);
    });

    test('throws TypeError when processMeasurement is missing', () => {
      const deps = buildFullDeps();
      delete deps.processMeasurement;
      assert.throws(() => createInst(deps), TypeError);
    });

    test('constructs without error when all required deps provided', () => {
      const inst = createInst(buildMinimalDeps());
      assert.ok(inst instanceof CalibrationOrchestrator);
    });

    test('gracefully degrades when optional callbacks are missing', () => {
      const deps = buildMinimalDeps();
      const inst = createInst(deps);
      assert.ok(inst instanceof CalibrationOrchestrator);
    });
  });

  describe('isRunning()', () => {
    test('returns false initially', () => {
      const inst = createInst(buildMinimalDeps());
      assert.equal(inst.isRunning(), false);
    });

    test('returns true when calibration is active', () => {
      const inst = createInst(buildMinimalDeps());
      inst._calibrationRunning = true;
      assert.equal(inst.isRunning(), true);
    });
  });

  describe('getState()', () => {
    test('returns object with running, liveVisData, liveEQGains, lastResult', () => {
      const inst = createInst(buildMinimalDeps());
      const state = inst.getState();
      assert.ok(typeof state === 'object');
      assert.equal(state.running, false);
      assert.equal(state.liveVisData, null);
      assert.equal(state.liveEQGains, null);
      assert.equal(state.lastResult, null);
    });

    test('reflects updated internal state', () => {
      const inst = createInst(buildMinimalDeps());
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
    test('does nothing when activeEQFilters is null', () => {
      const inst = createInst(buildMinimalDeps());
      inst.updateFilterPool([{ freq: 1000, gain: 3, Q: 2 }]);
    });

    test('updates filter parameters when filters exist', () => {
      const filters = Array.from({ length: 16 }, () => new MockBiquadFilter());
      const inst = createInst(buildMinimalDeps());
      inst._activeEQFilters = filters;

      inst.updateFilterPool([
        { freq: 200, gain: 2, Q: 1.5 },
        { freq: 1000, gain: -1.5, Q: 2 },
      ]);

      assert.equal(filters[0].frequency.value, 200);
      assert.equal(filters[0].gain.value, 2);
      assert.equal(filters[0].Q.value, 1.5);
      assert.equal(filters[2].gain.value, 0);
    });
  });

  describe('start()', () => {
    test('sets calibrationRunning to true', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      assert.equal(inst.isRunning(), true);
    });

    test('creates PinkNoise, filter pool, and convergence detector', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      assert.ok(inst._pinkNoise !== null);
      assert.ok(inst._convergenceDetector !== null);
      assert.ok(inst._activeEQFilters !== null);
      assert.equal(inst._activeEQFilters.length, 16);
      assert.ok(inst._cumulativeEQGains !== null);
      assert.equal(inst._cumulativeEQGains.length, 8);
    });

    test('initializes per-band gain limits', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      assert.ok(inst._perBandMaxGain !== null);
      assert.ok(inst._perBandMaxCut !== null);
      assert.equal(inst._perBandMaxGain.length, 8);
    });

    test('starts continuous measurement', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      assert.ok(inst._continuousMeasurement !== null);
    });

    test('sets the 30s watchdog timeout', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      assert.ok(inst._calibrationTimeout !== null);
    });

    test('is idempotent — calling twice does nothing', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      const pm = inst._pinkNoise;
      inst.start();
      assert.equal(inst._pinkNoise, pm);
    });

    test('calls onStatusChange with "Playing pink noise"', () => {
      let statusText = '';
      const deps = {
        ...buildMinimalDeps(),
        onStatusChange: ({ text }) => { statusText = text; },
      };
      const inst = createInst(deps);
      inst.start();
      assert.ok(statusText.includes('pink noise'));
    });

    test('resets state fields before starting', () => {
      const inst = createInst(buildFullDeps());
      inst._bestResult = { some: 'data' };
      inst._bestMaxDelta = 5;
      inst._validMeasurementCount = 10;

      inst.start();

      assert.equal(inst._bestResult, null);
      assert.equal(inst._bestMaxDelta, Infinity);
      assert.equal(inst._validMeasurementCount, 0);
    });

    test('state.running is true after start()', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      assert.equal(inst.getState().running, true);
    });
  });
});
