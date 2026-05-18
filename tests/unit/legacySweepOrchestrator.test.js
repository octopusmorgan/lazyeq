/**
 * Unit tests for LegacySweepOrchestrator — DI, stop, state, edge cases.
 *
 * run() lifecycle is covered by integration/E2E tests (requires browser or Vite).
 * These unit tests cover the constructor contract, state accessors, stop safety,
 * and edge cases without triggering sweep playback.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

// --- Global mocks for Node.js ---

// localStorage mock — needed by constants.js at module load time
const _store = {};
globalThis.localStorage = {
  getItem: (key) => _store[key] ?? null,
  setItem: (key, value) => { _store[key] = String(value); },
  removeItem: (key) => { delete _store[key]; },
  clear: () => { for (const k in _store) delete _store[k]; },
};

// --- Mocks ---

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 44100;
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
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
    return { buffer: null, loop: false, connect: () => {}, disconnect: () => {}, start: () => {}, stop: () => {} };
  }
  get destination() { return {}; }
}

function buildMinimalDeps() {
  return {
    analyzer: {
      getLinearFrequencyLabels: () => [100, 200, 500],
      getCurrentSpectrum: () => new Float32Array(128).fill(-60),
      audioContext: new MockAudioContext(),
      analyserNode: { fftSize: 256 },
      getCorrectedSpectrumFromDB: (s) => s,
      destroy: () => {},
    },
    audioContext: new MockAudioContext(),
    processMeasurement: () => ({
      visData: [{ x: 100, y: -20 }, { x: 200, y: -15 }],
      normalizedResponse: new Float32Array([-20, -15]),
      gains: [1, 2],
      rangeAvg: -10,
    }),
  };
}

// --- Tests ---

describe('LegacySweepOrchestrator', () => {
  let LegacySweepOrchestrator;

  before(async () => {
    LegacySweepOrchestrator = (await import('../../src/LegacySweepOrchestrator.js')).LegacySweepOrchestrator;
  });

  // ── Constructor — DI Contract ────────────────────────────────────────────

  describe('constructor — DI Contract', () => {
    test('throws TypeError when analyzer is missing', () => {
      assert.throws(
        () => new LegacySweepOrchestrator({ audioContext: new MockAudioContext(), processMeasurement: () => {} }),
        TypeError
      );
    });

    test('throws TypeError when audioContext is missing', () => {
      assert.throws(
        () => new LegacySweepOrchestrator({ analyzer: {}, processMeasurement: () => {} }),
        TypeError
      );
    });

    test('throws TypeError when processMeasurement is missing', () => {
      assert.throws(
        () => new LegacySweepOrchestrator({ analyzer: {}, audioContext: new MockAudioContext() }),
        TypeError
      );
    });

    test('constructs without error with required deps', () => {
      const orch = new LegacySweepOrchestrator(buildMinimalDeps());
      assert.ok(orch instanceof LegacySweepOrchestrator);
    });

    test('gracefully degrades when optional callbacks missing', () => {
      const orch = new LegacySweepOrchestrator(buildMinimalDeps());
      assert.equal(orch.isRunning(), false);
    });
  });

  // ── getState ─────────────────────────────────────────────────────────────

  describe('getState()', () => {
    test('returns correct shape initially', () => {
      const orch = new LegacySweepOrchestrator(buildMinimalDeps());
      const state = orch.getState();
      assert.equal(state.running, false);
      assert.equal(state.currentSweep, 0);
      assert.equal(state.totalSweeps, 0);
    });
  });

  // ── stop — Manual Termination ────────────────────────────────────────────

  describe('stop()', () => {
    test('no-op when no sweep running', () => {
      const orch = new LegacySweepOrchestrator(buildMinimalDeps());
      assert.doesNotThrow(() => orch.stop());
      assert.equal(orch.isRunning(), false);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    test('isRunning returns false initially', () => {
      const orch = new LegacySweepOrchestrator(buildMinimalDeps());
      assert.equal(orch.isRunning(), false);
    });

    test('constructor stores deps correctly', () => {
      const deps = buildMinimalDeps();
      const orch = new LegacySweepOrchestrator(deps);
      assert.equal(orch.isRunning(), false);
      // The deps are stored as _deps (private)
      assert.ok(orch._deps);
      assert.equal(orch._deps.analyzer, deps.analyzer);
      assert.equal(orch._deps.audioContext, deps.audioContext);
    });
  });
});
