/**
 * Unit tests for persistence bands field and Float32Array helpers.
 *
 * Tests the optional bands field added in PR-3:
 * - Round-trip save/load with bands
 * - Backward compatibility with profiles without bands
 * - Float32Array serialization helpers
 */

import { describe, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveProfile,
  loadProfile,
  loadPreviousProfile,
  float32ToArray,
  arrayToFloat32,
  setDevicePersistenceEnabled,
} from '../../src/persistence.js';

describe('Persistence — Bands Field (PR-3)', () => {
  // Mock localStorage
  const store = {};
  const mockLocalStorage = {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
    clear: () => { for (const k in store) delete store[k]; },
  };

  beforeEach(() => {
    mockLocalStorage.clear();
    globalThis.localStorage = mockLocalStorage;
    setDevicePersistenceEnabled(false);
  });

  describe('saveProfile with bands', () => {
    test('round-trip: save profile with bands → load → bands match', () => {
      const bands = [
        { freq: 100, gain: -3.5, Q: 1.2 },
        { freq: 500, gain: 2.0, Q: 0.8 },
        { freq: 2000, gain: -1.0, Q: 2.0 },
      ];
      const profile = {
        gains: new Float32Array([1, 2, 3]),
        timestamp: 1234567890,
        type: 'pink-noise',
        bands,
      };
      saveProfile(profile);
      const loaded = loadProfile();

      assert.ok(loaded);
      assert.ok(loaded.bands);
      assert.equal(loaded.bands.length, 3);
      assert.deepEqual(loaded.bands, bands);
    });

    test('save profile without bands → bands is undefined', () => {
      const profile = {
        gains: new Float32Array([1, 2, 3]),
        timestamp: 1234567890,
        type: 'pink-noise',
      };
      saveProfile(profile);
      const loaded = loadProfile();

      assert.ok(loaded);
      assert.equal(loaded.bands, undefined);
    });

    test('save profile with empty bands array → bands is empty array', () => {
      const profile = {
        gains: new Float32Array([1, 2, 3]),
        timestamp: 1234567890,
        type: 'pink-noise',
        bands: [],
      };
      saveProfile(profile);
      const loaded = loadProfile();

      assert.ok(loaded);
      assert.ok(Array.isArray(loaded.bands));
      assert.equal(loaded.bands.length, 0);
    });
  });

  describe('backward compatibility', () => {
    test('load profile without bands field → gains match, bands undefined', () => {
      // Simulate an old-format profile stored directly
      store['lazyEq_calibration'] = JSON.stringify({
        gains: [1.5, -2.3, 0, 4.7],
        timestamp: 1234567890,
        type: 'pink-noise',
      });

      const loaded = loadProfile();
      assert.ok(loaded);
      assert.ok(loaded.gains instanceof Float32Array);
      assert.equal(loaded.gains.length, 4);
      // Float32 has limited precision — use approximate comparison
      assert.ok(Math.abs(loaded.gains[0] - 1.5) < 0.001);
      assert.ok(Math.abs(loaded.gains[1] - (-2.3)) < 0.001);
      assert.ok(Math.abs(loaded.gains[2] - 0) < 0.001);
      assert.ok(Math.abs(loaded.gains[3] - 4.7) < 0.001);
      assert.equal(loaded.bands, undefined);
    });

    test('load old format profile via saveProfile round-trip → bands absent', () => {
      // Save without bands (old format)
      saveProfile({
        gains: new Float32Array([0, 1, 2]),
        timestamp: 999,
        type: 'sweep',
      });
      const loaded = loadProfile();
      assert.ok(loaded);
      assert.equal(loaded.bands, undefined);
      assert.equal(loaded.type, 'sweep');
    });
  });

  describe('loadPreviousProfile with bands', () => {
    test('previous profile preserves bands after dual-slot save', () => {
      const bands1 = [{ freq: 200, gain: -2.0, Q: 1.5 }];
      saveProfile({
        gains: new Float32Array([1, 2, 3]),
        timestamp: 1000,
        type: 'pink-noise',
        bands: bands1,
      });

      saveProfile({
        gains: new Float32Array([4, 5, 6]),
        timestamp: 2000,
        type: 'pink-noise',
        bands: [{ freq: 300, gain: 1.0, Q: 0.7 }],
      });

      const previous = loadPreviousProfile();
      assert.ok(previous);
      assert.ok(previous.bands);
      assert.equal(previous.bands.length, 1);
      assert.equal(previous.bands[0].freq, 200);
    });
  });

  describe('Float32Array serialization helpers', () => {
    test('float32ToArray converts to plain array', () => {
      const f32 = new Float32Array([1.5, -2.3, 0, 4.7]);
      const arr = float32ToArray(f32);
      assert.ok(Array.isArray(arr));
      assert.equal(arr.length, 4);
      // Float32 has limited precision — use approximate comparison
      assert.ok(Math.abs(arr[0] - 1.5) < 0.001);
      assert.ok(Math.abs(arr[1] - (-2.3)) < 0.001);
      assert.ok(Math.abs(arr[2] - 0) < 0.001);
      assert.ok(Math.abs(arr[3] - 4.7) < 0.001);
    });

    test('arrayToFloat32 converts back to Float32Array', () => {
      const arr = [1.5, -2.3, 0, 4.7];
      const f32 = arrayToFloat32(arr);
      assert.ok(f32 instanceof Float32Array);
      assert.equal(f32.length, 4);
      // Float32 has limited precision — use approximate comparison
      assert.ok(Math.abs(f32[0] - 1.5) < 0.001);
      assert.ok(Math.abs(f32[1] - (-2.3)) < 0.001);
      assert.ok(Math.abs(f32[2] - 0) < 0.001);
      assert.ok(Math.abs(f32[3] - 4.7) < 0.001);
    });

    test('float32ToArray → arrayToFloat32 round-trip', () => {
      const original = new Float32Array([0.1, -0.2, 0.3, -0.4, 0.5]);
      const roundTripped = arrayToFloat32(float32ToArray(original));
      assert.ok(roundTripped instanceof Float32Array);
      assert.equal(roundTripped.length, original.length);
      for (let i = 0; i < original.length; i++) {
        assert.equal(roundTripped[i], original[i]);
      }
    });

    test('float32ToArray produces JSON-serializable output', () => {
      const f32 = new Float32Array([1.0, 2.0, 3.0]);
      const arr = float32ToArray(f32);
      const json = JSON.stringify(arr);
      const parsed = JSON.parse(json);
      assert.deepEqual(parsed, [1.0, 2.0, 3.0]);
    });
  });
});
