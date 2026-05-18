/**
 * Unit tests for CalibrationOrchestrator — Commit 2: _onMeasurement.
 *
 * Tests constructor DI contract, state accessors, filter pool,
 * start() lifecycle, and the _onMeasurement() callback.
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
    this.frequency = { value: 1000, setTargetAtTime: (v) => { this.frequency.value = v; } };
    this.gain = { value: 0, setTargetAtTime: (v) => { this.gain.value = v; } };
    this.Q = { value: 1.0, setTargetAtTime: (v) => { this.Q.value = v; } };
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
  createBiquadFilter() { return new MockBiquadFilter(); }
  createBuffer(channels, length, sampleRate) {
    return { numberOfChannels: channels, length, sampleRate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    return { buffer: null, loop: false, connect: () => {}, disconnect: () => {}, start: () => {}, stop: () => {} };
  }
}

class MockConvergenceDetector {
  constructor() { this.windowCount = 0; this._windows = []; }
  push(gains) {
    this._windows.push(gains);
    this.windowCount = this._windows.length;
    return { converged: false, delta: 1.0 };
  }
  reset() { this._windows = []; this.windowCount = 0; }
}

function buildMinimalDeps() {
  return {
    analyzer: {
      getLinearFrequencyLabels: () => [100, 200, 500],
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
    processMeasurement: () => ({
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

describe('CalibrationOrchestrator — Commit 2 (+_onMeasurement)', () => {
  let CalibrationOrchestrator;
  const _instances = [];

  before(async () => {
    globalThis.localStorage = localStorageMock;
    CalibrationOrchestrator = (await import('../../src/CalibrationOrchestrator.js')).CalibrationOrchestrator;
  });

  after(() => {
    for (const inst of _instances) {
      if (inst._calibrationTimeout) { clearTimeout(inst._calibrationTimeout); inst._calibrationTimeout = null; }
    }
  });

  function createInst(deps) {
    const inst = new CalibrationOrchestrator(deps);
    _instances.push(inst);
    return inst;
  }

  // ── Constructor ────────────────────────────────────────────────────────

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
    test('constructs without error with required deps', () => {
      const inst = createInst(buildMinimalDeps());
      assert.ok(inst instanceof CalibrationOrchestrator);
    });
    test('gracefully degrades when optional callbacks missing', () => {
      const inst = createInst(buildMinimalDeps());
      assert.ok(inst instanceof CalibrationOrchestrator);
    });
  });

  // ── Accessors ───────────────────────────────────────────────────────────

  describe('isRunning()', () => {
    test('returns false initially', () => {
      const inst = createInst(buildMinimalDeps());
      assert.equal(inst.isRunning(), false);
    });
    test('returns true when active', () => {
      const inst = createInst(buildMinimalDeps());
      inst._calibrationRunning = true;
      assert.equal(inst.isRunning(), true);
    });
  });

  describe('getState()', () => {
    test('returns correct shape initially', () => {
      const inst = createInst(buildMinimalDeps());
      const s = inst.getState();
      assert.equal(s.running, false);
      assert.equal(s.liveVisData, null);
      assert.equal(s.liveEQGains, null);
      assert.equal(s.lastResult, null);
    });
    test('reflects updated state', () => {
      const inst = createInst(buildMinimalDeps());
      inst._calibrationRunning = true;
      inst._liveVisData = [{ x: 100, y: -20 }];
      const s = inst.getState();
      assert.equal(s.running, true);
      assert.ok(s.liveVisData.length > 0);
    });
  });

  describe('updateFilterPool()', () => {
    test('does nothing when null', () => {
      const inst = createInst(buildMinimalDeps());
      inst.updateFilterPool([{ freq: 1000, gain: 3, Q: 2 }]);
    });
    test('updates filter parameters', () => {
      const filters = Array.from({ length: 16 }, () => new MockBiquadFilter());
      const inst = createInst(buildMinimalDeps());
      inst._activeEQFilters = filters;
      inst.updateFilterPool([{ freq: 200, gain: 2, Q: 1.5 }]);
      assert.equal(filters[0].frequency.value, 200);
      assert.equal(filters[0].gain.value, 2);
    });
  });

  // ── start() ─────────────────────────────────────────────────────────────

  describe('start()', () => {
    test('sets calibrationRunning to true', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      assert.equal(inst.isRunning(), true);
    });
    test('creates PinkNoise, filters, convergence detector', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      assert.ok(inst._pinkNoise);
      assert.ok(inst._convergenceDetector);
      assert.equal(inst._activeEQFilters.length, 16);
      assert.equal(inst._cumulativeEQGains.length, 8);
    });
    test('starts continuous measurement', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      assert.ok(inst._continuousMeasurement);
    });
    test('sets watchdog timeout', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      assert.ok(inst._calibrationTimeout);
    });
    test('is idempotent', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      const pm = inst._pinkNoise;
      inst.start();
      assert.equal(inst._pinkNoise, pm);
    });
    test('resets state before starting', () => {
      const inst = createInst(buildFullDeps());
      inst._bestResult = { some: 'data' };
      inst._bestMaxDelta = 5;
      inst.start();
      assert.equal(inst._bestResult, null);
      assert.equal(inst._bestMaxDelta, Infinity);
    });
  });

  // ── _onMeasurement() — SNR and timeout guards ─────────────────────────

  describe('_onMeasurement() — guards', () => {
    test('returns early when analyzer is null (race condition)', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      // Simulate analyzer being destroyed
      const origAnalyzer = inst._deps.analyzer;
      inst._deps.analyzer = null;
      inst._onMeasurement({ spectrum: new Float32Array(1024), rms: -50, elapsedMs: 500 });
      inst._deps.analyzer = origAnalyzer;
    });

    test('increments consecutiveSNRSkips when SNR is below threshold', () => {
      const deps = {
        ...buildFullDeps(),
        analyzer: {
          ...buildFullDeps().analyzer,
          getNoiseFloorRMS: () => -50,  // high noise floor
          getCorrectedSpectrumFromDB: (s) => s,
        },
      };
      const inst = createInst(deps);
      inst.start();
      inst._validMeasurementCount = 0;
      inst._onMeasurement({ spectrum: new Float32Array(1024), rms: -55, elapsedMs: 500 });
      assert.equal(inst._consecutiveSNRSkips, 1);
      assert.equal(inst._validMeasurementCount, 0); // not counted
    });

    test('resets SNR skip counter on valid measurement', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      inst._consecutiveSNRSkips = 5;
      inst._validMeasurementCount = 0;
      // Low noise floor + good RMS = no SNR gate
      inst._onMeasurement({ spectrum: new Float32Array(1024), rms: -50, elapsedMs: 500 });
      assert.equal(inst._consecutiveSNRSkips, 0);
      assert.equal(inst._validMeasurementCount, 1);
    });

    test('calls onStatusChange with low SNR warning after 20 skips', () => {
      let statusText = '';
      const deps = {
        ...buildFullDeps(),
        analyzer: {
          ...buildFullDeps().analyzer,
          getNoiseFloorRMS: () => -50,
          getCorrectedSpectrumFromDB: (s) => s,
        },
        onStatusChange: ({ text }) => { statusText = text; },
      };
      const inst = createInst(deps);
      inst.start();
      inst._consecutiveSNRSkips = 19;
      inst._onMeasurement({ spectrum: new Float32Array(1024), rms: -55, elapsedMs: 500 });
      assert.ok(statusText.includes('signal-to-noise'));
      assert.equal(inst._consecutiveSNRSkips, 20);
    });
  });

  // ── _onMeasurement() — low input warnings ─────────────────────────────

  describe('_onMeasurement() — low input', () => {
    test('increments lowInputWarningCount when RMS < -60', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      inst._lowInputWarningCount = 0;
      inst._onMeasurement({ spectrum: new Float32Array(1024), rms: -65, elapsedMs: 500 });
      assert.equal(inst._lowInputWarningCount, 1);
    });

    test('resets lowInputWarningCount when RMS >= -60', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      inst._lowInputWarningCount = 5;
      inst._onMeasurement({ spectrum: new Float32Array(1024), rms: -50, elapsedMs: 500 });
      assert.equal(inst._lowInputWarningCount, 0);
    });
  });

  // ── _onMeasurement() — timeout ──────────────────────────────────────────

  describe('_onMeasurement() — timeout', () => {
    test('calls _finish with timedOut when elapsedMs exceeds CALIBRATION_TIMEOUT_MS and result exists', () => {
      let calledResult = null;
      let calledOptions = null;
      const deps = {
        ...buildFullDeps(),
        onComplete: (r, o) => { calledResult = r; calledOptions = o; },
      };
      const inst = createInst(deps);
      inst.start();
      inst._lastMeasurementResult = { visData: [{ x: 100, y: -20 }], gains: [1] };
      inst._cumulativeEQGains = new Float32Array(8);
      inst._onMeasurement({ spectrum: new Float32Array(1024), rms: -50, elapsedMs: 35000 });
      assert.ok(calledResult !== null);
      assert.equal(calledOptions.timedOut, true);
    });
  });

  // ── _buildPartialResult() and _interpolateEQGains() ────────────────────

  describe('_buildPartialResult()', () => {
    test('returns lastResult when no cumulative gains', () => {
      const inst = createInst(buildMinimalDeps());
      const last = { visData: [{ x: 100, y: -20 }], normalizedResponse: new Float32Array([-20]), rangeAvg: -10 };
      assert.equal(inst._buildPartialResult(last, null), last);
    });
    test('interpolates cumulative gains', () => {
      const inst = createInst(buildMinimalDeps());
      const last = {
        visData: [{ x: 63, y: -20 }, { x: 125, y: -15 }],
        normalizedResponse: new Float32Array([-20, -15]),
        rangeAvg: -10,
      };
      const cg = new Float32Array([2, 1, 0, -1, -2, -3, -4, -5]);
      const r = inst._buildPartialResult(last, cg);
      assert.equal(r.gains.length, 2);
    });
  });

  describe('_interpolateEQGains()', () => {
    test('extrapolates below lowest band', () => {
      const inst = createInst(buildMinimalDeps());
      assert.equal(inst._interpolateEQGains(20, new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])), 1);
    });
    test('extrapolates above highest band', () => {
      const inst = createInst(buildMinimalDeps());
      assert.equal(inst._interpolateEQGains(16000, new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])), 8);
    });
    test('interpolates at exact band frequency', () => {
      const inst = createInst(buildMinimalDeps());
      assert.equal(inst._interpolateEQGains(125, new Float32Array([0, 10, 20, 30, 40, 50, 60, 70])), 10);
    });
  });

  // ── State after start ──────────────────────────────────────────────────

  describe('getState() after start/stop', () => {
    test('running is true after start', () => {
      const inst = createInst(buildFullDeps());
      inst.start();
      assert.equal(inst.getState().running, true);
    });
  });
});
