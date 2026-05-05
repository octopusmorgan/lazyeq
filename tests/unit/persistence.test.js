/**
 * Unit tests for persistence module.
 *
 * Mocks localStorage for Node.js environment.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { saveProfile, loadProfile } from '../../src/persistence.js';

describe('Persistence', () => {
  // Mock localStorage
  const store = {};
  const mockLocalStorage = {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
    clear: () => { for (const k in store) delete store[k]; },
  };

  // Replace global localStorage for tests
  beforeEach(() => {
    mockLocalStorage.clear();
    globalThis.localStorage = mockLocalStorage;
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
});
