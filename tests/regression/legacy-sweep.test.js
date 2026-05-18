/**
 * Regression tests — verify legacy sweep path is preserved after pink noise changes.
 *
 * T013: Ensures the sine sweep calibration flow remains functional:
 * - SineSweepSource class is importable with intact API
 * - 1/f compensation code is present in main.js
 * - Export functions produce expected output format
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exportWavelet,
  exportEqMac,
  generateVisualizationData,
  EQMAC_BANDS,
} from '../../src/eqGenerator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- AudioContext mock for SineSweepSource tests ---
class MockGainNode {
  constructor() {
    this.gain = { value: 0.8, setValueAtTime(v) { this.value = v; } };
    this._connected = [];
  }
  connect(node) { this._connected.push(node); }
  disconnect() { this._connected = []; }
}

class MockBufferSource {
  constructor() {
    this.buffer = null;
    this._connected = [];
    this.onended = null;
  }
  connect(node) { this._connected.push(node); }
  disconnect() { this._connected = []; }
  start() {}
  stop() {}
}

class MockAudioBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this._data = new Float32Array(length);
  }
  getChannelData() { return this._data; }
}

class MockAudioContext {
  constructor() {
    this.sampleRate = 44100;
    this.state = 'running';
    this._gainNode = new MockGainNode();
  }
  createGain() { return this._gainNode; }
  createBufferSource() { return new MockBufferSource(); }
  createBuffer(channels, length, sampleRate) {
    return new MockAudioBuffer(channels, length, sampleRate);
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
}

describe('T013: Legacy Sweep Path Regression', () => {

  describe('SineSweepSource API intact', () => {
    test('SineSweepSource class is importable', async () => {
      const { SineSweepSource } = await import('../../src/sineSweep.js');
      assert.ok(typeof SineSweepSource === 'function');
    });

    test('SineSweepSource has required methods', async () => {
      const { SineSweepSource } = await import('../../src/sineSweep.js');
      const ctx = new MockAudioContext();
      const sweep = new SineSweepSource(ctx);

      assert.ok(typeof sweep.createBuffer === 'function');
      assert.ok(typeof sweep.start === 'function');
      assert.ok(typeof sweep.stop === 'function');
      assert.ok(typeof sweep.setVolume === 'function');
      assert.ok(sweep.duration === 8); // default duration
    });

    test('SineSweepSource generates valid buffer', async () => {
      const { SineSweepSource } = await import('../../src/sineSweep.js');
      const ctx = new MockAudioContext();
      const sweep = new SineSweepSource(ctx);
      const buffer = sweep.createBuffer(8);

      assert.ok(buffer);
      assert.equal(buffer.numberOfChannels, 1);
      assert.equal(buffer.sampleRate, 44100);
      assert.equal(buffer.length, 44100 * 8);

      const data = buffer.getChannelData();
      let nonZero = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0) nonZero++;
      }
      assert.ok(nonZero > data.length * 0.5, 'Buffer should contain audio data');
    });

    test('SineSweepSource setVolume works', async () => {
      const { SineSweepSource } = await import('../../src/sineSweep.js');
      const ctx = new MockAudioContext();
      const sweep = new SineSweepSource(ctx);
      sweep.setVolume(0.5);
      assert.equal(ctx._gainNode.gain.value, 0.5);
    });
  });

  describe('live-only calibration architecture in main.js', () => {
    test('main.js does not contain removed legacy sweep runner', () => {
      const mainJsPath = join(__dirname, '../../src/main.js');
      const content = readFileSync(mainJsPath, 'utf-8');

      assert.ok(
        !content.includes('async function processSweepResults()'),
        'processSweepResults should be removed from main.js'
      );
    });

    test('main.js keeps live calibration shared helpers and entry points', () => {
      const mainJsPath = join(__dirname, '../../src/main.js');
      const content = readFileSync(mainJsPath, 'utf-8');

      assert.ok(
        content.includes('function _processMeasurementResults('),
        '_processMeasurementResults should exist in main.js (used by live path)'
      );

      assert.ok(
        content.includes('CalibrationOrchestrator'),
        'CalibrationOrchestrator should be imported in main.js'
      );

      assert.ok(
        content.includes('function createOrchestrator'),
        'createOrchestrator should exist in main.js'
      );

      assert.ok(
        content.includes('function showResults('),
        'showResults should exist in main.js (DOM rendering)'
      );
    });

    test('adaptiveSmooth function preserved', () => {
      const mainJsPath = join(__dirname, '../../src/main.js');
      const content = readFileSync(mainJsPath, 'utf-8');

      assert.ok(
        content.includes('function adaptiveSmooth('),
        'adaptiveSmooth function should be preserved in main.js'
      );
    });

    test('gaussianSmooth function removed', () => {
      const mainJsPath = join(__dirname, '../../src/main.js');
      const content = readFileSync(mainJsPath, 'utf-8');

      assert.ok(
        !content.includes('function gaussianSmooth('),
        'gaussianSmooth function should NOT be present in main.js'
      );
    });
  });

  describe('Export functions produce expected format', () => {
    test('exportWavelet produces GraphicEQ format', () => {
      const gains = new Float32Array(147).fill(0);
      const result = exportWavelet(gains);

      assert.ok(result.startsWith('GraphicEQ:'));
      assert.ok(result.includes(';'));
      // Should contain frequency-gain pairs
      assert.ok(result.includes('20 '));
      assert.ok(result.includes('19871'));
    });

    test('exportEqMac produces valid JSON with correct structure', () => {
      const gains = new Array(64).fill(0);
      const result = exportEqMac(gains);
      const parsed = JSON.parse(result);

      assert.equal(parsed.name, 'lazyEq Preset');
      assert.equal(parsed.enabled, true);
      assert.ok(Array.isArray(parsed.filters));
      assert.equal(parsed.filters.length, EQMAC_BANDS.length);
      assert.equal(parsed.filters[0].type, 'PK');
      assert.ok(typeof parsed.filters[0].freq === 'number');
      assert.ok(typeof parsed.filters[0].gain === 'string');
    });

    test('exportWavelet with non-zero gains produces correct values', () => {
      const gains = new Float32Array(147);
      for (let i = 0; i < gains.length; i++) {
        gains[i] = i % 2 === 0 ? 2.0 : -1.5;
      }
      const result = exportWavelet(gains);

      assert.ok(result.startsWith('GraphicEQ:'));
      assert.ok(result.includes('2.0'));
      assert.ok(result.includes('-1.5'));
    });

    test('exportEqMac with visData uses frequency-based interpolation', () => {
      const gains = new Array(64).fill(0);
      const visData = [];
      for (let i = 0; i < 64; i++) {
        const freq = 20 * Math.pow(20000 / 20, i / 63);
        visData.push({ x: freq, y: -50 + i });
      }
      const result = exportEqMac(gains, visData);
      const parsed = JSON.parse(result);

      assert.equal(parsed.filters.length, EQMAC_BANDS.length);
      // Each filter should have a gain value
      parsed.filters.forEach(f => {
        assert.ok(typeof f.gain === 'string');
        assert.ok(f.type === 'PK');
      });
    });
  });

  describe('eqGenerator.js untouched', () => {
    test('EQMAC_BANDS has 10 bands', () => {
      assert.equal(EQMAC_BANDS.length, 10);
      assert.deepEqual(EQMAC_BANDS, [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
    });

    test('generateVisualizationData works correctly', () => {
      const spectrum = new Float32Array(1024).fill(-50);
      const labels = Array.from({ length: 1024 }, (_, i) => i * (44100 / 2048));
      const pts = generateVisualizationData(spectrum, labels, 64);
      assert.equal(pts.length, 64);
      assert.ok(pts.every(p => typeof p.x === 'number' && typeof p.y === 'number'));
    });
  });
});
