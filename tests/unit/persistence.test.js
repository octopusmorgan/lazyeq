/**
 * Unit tests for persistence module.
 *
 * Mocks localStorage for Node.js environment.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { saveProfile, loadProfile, loadPreviousProfile, isProfileSaturated, setDevicePersistenceEnabled } from '../../src/persistence.js';

describe('Persistence', () => {
  // Mock localStorage
  const store = {};
  const mockLocalStorage = {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
    clear: () => { for (const k in store) delete store[k]; },
  };

  // Replace global localStorage for tests — disable device scoping for clean assertions
  beforeEach(() => {
    mockLocalStorage.clear();
    globalThis.localStorage = mockLocalStorage;
    setDevicePersistenceEnabled(false);
  });

  test('saveProfile stores data in localStorage', () => {
    const profile = {
      gains: new Float32Array([1, 2, 3]),
      timestamp: 1234567890,
      type: 'pink-noise',
    };
    saveProfile(profile);
    assert.ok(store['lazyEq_calibration']);
  });

  test('loadProfile returns null when no data exists', () => {
    const result = loadProfile();
    assert.equal(result, null);
  });

  test('save → load round-trip preserves data', () => {
    const original = {
      gains: new Float32Array([1.5, -2.3, 0, 4.7]),
      timestamp: 1234567890,
      type: 'pink-noise',
    };
    saveProfile(original);
    const loaded = loadProfile();

    assert.ok(loaded);
    assert.equal(loaded.timestamp, original.timestamp);
    assert.equal(loaded.type, original.type);
    assert.ok(loaded.gains instanceof Float32Array);
    assert.equal(loaded.gains.length, original.gains.length);
    for (let i = 0; i < loaded.gains.length; i++) {
      assert.equal(loaded.gains[i], original.gains[i]);
    }
  });

  test('handles null gains', () => {
    const profile = {
      gains: null,
      timestamp: 1234567890,
      type: 'sweep',
    };
    saveProfile(profile);
    const loaded = loadProfile();
    assert.ok(loaded);
    assert.equal(loaded.gains, null);
    assert.equal(loaded.timestamp, 1234567890);
    assert.equal(loaded.type, 'sweep');
  });

  test('returns null on corrupt JSON', () => {
    store['lazyEq_calibration'] = 'not valid json{{{';
    const result = loadProfile();
    assert.equal(result, null);
  });

  test('returns null on missing timestamp', () => {
    store['lazyEq_calibration'] = JSON.stringify({
      gains: [1, 2, 3],
      type: 'pink-noise',
    });
    const result = loadProfile();
    assert.equal(result, null);
  });

  test('returns null on missing type', () => {
    store['lazyEq_calibration'] = JSON.stringify({
      gains: [1, 2, 3],
      timestamp: 1234567890,
    });
    const result = loadProfile();
    assert.equal(result, null);
  });

  test('returns null on invalid type', () => {
    store['lazyEq_calibration'] = JSON.stringify({
      gains: [1, 2, 3],
      timestamp: 1234567890,
      type: 'invalid-type',
    });
    const result = loadProfile();
    assert.equal(result, null);
  });

  test('accepts both pink-noise and sweep types', () => {
    for (const type of ['pink-noise', 'sweep']) {
      store['lazyEq_calibration'] = JSON.stringify({
        gains: [1, 2, 3],
        timestamp: 1234567890,
        type,
      });
      const result = loadProfile();
      assert.ok(result, `Should accept type: ${type}`);
      assert.equal(result.type, type);
    }
  });

  test('empty gains array round-trips correctly', () => {
    const profile = {
      gains: new Float32Array([]),
      timestamp: 9999999999,
      type: 'pink-noise',
    };
    saveProfile(profile);
    const loaded = loadProfile();
    assert.ok(loaded);
    assert.ok(loaded.gains instanceof Float32Array);
    assert.equal(loaded.gains.length, 0);
  });

  // Phase 2: dual-slot persistence
  test('saveProfile moves current → previous before saving new', () => {
    const profile1 = {
      gains: new Float32Array([1, 2, 3]),
      timestamp: 1000,
      type: 'pink-noise',
    };
    saveProfile(profile1);

    // profile2 must NOT be saturated (all values within ±4dB)
    const profile2 = {
      gains: new Float32Array([1, -1, 2, -2, 3, -3, 0.5, -0.5]),
      timestamp: 2000,
      type: 'pink-noise',
    };
    saveProfile(profile2);

    // Current should be profile2
    const current = loadProfile();
    assert.ok(current);
    assert.equal(current.timestamp, 2000);

    // Previous should be profile1
    const previous = loadPreviousProfile();
    assert.ok(previous);
    assert.equal(previous.timestamp, 1000);
  });

  test('loadPreviousProfile returns null when no previous exists', () => {
    const result = loadPreviousProfile();
    assert.equal(result, null);
  });

  test('saveProfile returns rolledBack: true when saturated and previous exists', () => {
    // First save a normal profile
    saveProfile({
      gains: new Float32Array([1, 2, 3]),
      timestamp: 1000,
      type: 'pink-noise',
    });

    // Now save a saturated profile (all at ±4dB)
    const saturated = {
      gains: new Float32Array([4, 4, 4, -4, -4, -4, 4, -4]),
      timestamp: 2000,
      type: 'pink-noise',
    };
    const result = saveProfile(saturated);
    assert.equal(result.rolledBack, true);

    // Current should still be the previous (non-saturated) profile
    const current = loadProfile();
    assert.ok(current);
    assert.equal(current.timestamp, 1000);
  });

  test('saveProfile returns rolledBack: false when no previous exists (first save)', () => {
    mockLocalStorage.clear();
    const saturated = {
      gains: new Float32Array([4, 4, 4, -4, -4, -4, 4, -4]),
      timestamp: 1000,
      type: 'pink-noise',
    };
    const result = saveProfile(saturated);
    assert.equal(result.rolledBack, false);
  });

  test('saveProfile returns rolledBack: false for non-saturated profile', () => {
    saveProfile({
      gains: new Float32Array([1, 2, 3]),
      timestamp: 1000,
      type: 'pink-noise',
    });

    const normal = {
      gains: new Float32Array([1, -1, 0.5, -0.5, 2, -2, 3, -3]),
      timestamp: 2000,
      type: 'pink-noise',
    };
    const result = saveProfile(normal);
    assert.equal(result.rolledBack, false);
  });

  test('isProfileSaturated returns true when all bands at ±4dB', () => {
    assert.equal(isProfileSaturated(new Float32Array([4, 4, 4, 4, 4, 4, 4, 4])), true);
    assert.equal(isProfileSaturated(new Float32Array([-4, -4, -4, -4, -4, -4, -4, -4])), true);
    assert.equal(isProfileSaturated(new Float32Array([4, -4, 4, -4, 4, -4, 4, -4])), true);
  });

  test('isProfileSaturated returns false when any band is within limits', () => {
    assert.equal(isProfileSaturated(new Float32Array([4, 4, 3.9, 4, 4, 4, 4, 4])), false);
    assert.equal(isProfileSaturated(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0])), false);
    assert.equal(isProfileSaturated(new Float32Array([4, 4, 4, 4, 4, 4, 4, 3.9])), false);
  });

  test('isProfileSaturated handles empty/null input', () => {
    assert.equal(isProfileSaturated(null), false);
    assert.equal(isProfileSaturated(new Float32Array([])), false);
  });
});
