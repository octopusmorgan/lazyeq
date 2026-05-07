/**
 * Regression tests — verify export functions produce correct, deterministic output.
 *
 * Tests exportWavelet and exportEqMac from eqGenerator.js directly.
 * These are pure functions (no DOM dependency) so they can run in Node.js.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { exportWavelet, exportEqMac } from '../../src/eqGenerator.js';

describe('T-3.5: Export Formats Regression', () => {

  describe('exportWavelet', () => {
    test('produces GraphicEQ format with correct prefix', () => {
      const gains = new Float32Array(147).fill(0);
      const result = exportWavelet(gains);
      assert.ok(result.startsWith('GraphicEQ:'));
    });

    test('contains frequency-gain pairs separated by semicolons', () => {
      const gains = new Float32Array(147).fill(0);
      const result = exportWavelet(gains);
      assert.ok(result.includes(';'));
    });

    test('spans the full frequency range (20 Hz to ~20 kHz)', () => {
      const gains = new Float32Array(147).fill(0);
      const result = exportWavelet(gains);
      assert.ok(result.includes('20 '));
      assert.ok(result.includes('19871'));
    });

    test('with non-zero gains produces correct values', () => {
      const gains = new Float32Array(147);
      for (let i = 0; i < gains.length; i++) {
        gains[i] = i % 2 === 0 ? 2.0 : -1.5;
      }
      const result = exportWavelet(gains);
      assert.ok(result.includes('2.0'));
      assert.ok(result.includes('-1.5'));
    });

    test('is deterministic (same input → same output)', () => {
      const gains = new Float32Array(147);
      for (let i = 0; i < gains.length; i++) {
        gains[i] = Math.sin(i * 0.1) * 3;
      }
      const result1 = exportWavelet(gains);
      const result2 = exportWavelet(gains);
      assert.equal(result1, result2);
    });
  });

  describe('exportEqMac', () => {
    test('produces valid JSON', () => {
      const gains = new Array(64).fill(0);
      const result = exportEqMac(gains);
      const parsed = JSON.parse(result);
      assert.ok(parsed);
    });

    test('has correct top-level structure', () => {
      const gains = new Array(64).fill(0);
      const result = exportEqMac(gains);
      const parsed = JSON.parse(result);
      assert.equal(parsed.name, 'lazyEq Preset');
      assert.equal(parsed.enabled, true);
      assert.ok(Array.isArray(parsed.filters));
    });

    test('produces one filter per EQMAC band', () => {
      const gains = new Array(64).fill(0);
      const result = exportEqMac(gains);
      const parsed = JSON.parse(result);
      assert.equal(parsed.filters.length, 10); // EQMAC_BANDS has 10 bands
    });

    test('each filter has PK type and numeric freq', () => {
      const gains = new Array(64).fill(0);
      const result = exportEqMac(gains);
      const parsed = JSON.parse(result);
      parsed.filters.forEach(f => {
        assert.equal(f.type, 'PK');
        assert.ok(typeof f.freq === 'number');
        assert.ok(typeof f.gain === 'string');
      });
    });

    test('is deterministic (same input → same output)', () => {
      const gains = new Array(64).fill(0);
      for (let i = 0; i < gains.length; i++) {
        gains[i] = Math.cos(i * 0.2) * 2;
      }
      const result1 = exportEqMac(gains);
      const result2 = exportEqMac(gains);
      assert.equal(result1, result2);
    });

    test('with visData produces interpolated gains', () => {
      const gains = new Array(64).fill(0);
      const visData = [];
      for (let i = 0; i < 64; i++) {
        const freq = 20 * Math.pow(20000 / 20, i / 63);
        visData.push({ x: freq, y: -50 + i });
      }
      const result = exportEqMac(gains, visData);
      const parsed = JSON.parse(result);
      assert.equal(parsed.filters.length, 10);
      parsed.filters.forEach(f => {
        assert.ok(typeof f.gain === 'string');
        assert.equal(f.type, 'PK');
      });
    });
  });
});
