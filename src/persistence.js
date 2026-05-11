/**
 * Persistence — save/load calibration profiles to localStorage.
 *
 * Profile shape: { gains: Float32Array|null, timestamp: number, type: 'pink-noise'|'sweep', bands?: ParametricBand[] }
 *
 * Float32Array is converted to a plain Array for JSON serialization.
 * ParametricBand[] is serialized as a plain array of {freq, gain, Q} objects.
 *
 * Device-aware mode: when enabled (default), profiles are scoped by device fingerprint.
 * Fingerprint = screen dimensions + user agent hash. Disable to share profiles across devices.
 */

const STORAGE_KEY_BASE = 'lazyEq_calibration';
const STORAGE_KEY_BASE_PREV = 'lazyEq_calibration_prev';
const DEVICE_PERSISTENCE_KEY = 'lazyEq_device_persistence';

let _persistenceEnabled = null;

/**
 * Generate a device fingerprint for storage key scoping.
 * Uses screen dimensions + user agent + language for reasonable uniqueness.
 * @returns {string} Short device hash
 */
export function getDeviceFingerprint() {
  // Node.js / test environment — no screen/navigator available
  if (typeof screen === 'undefined' || typeof navigator === 'undefined') {
    return 'node-test-env';
  }
  const raw = `${screen.width}x${screen.height}|${navigator.userAgent}|${navigator.language}`;
  // Simple hash: btoa + trim to 12 chars
  return btoa(raw).replace(/[+/=]/g, '').slice(0, 12);
}

/**
 * Check if device-scoped persistence is enabled.
 * @returns {boolean}
 */
export function isDevicePersistenceEnabled() {
  if (_persistenceEnabled !== null) return _persistenceEnabled;
  try {
    const stored = localStorage.getItem(DEVICE_PERSISTENCE_KEY);
    _persistenceEnabled = stored !== 'false'; // default true
  } catch {
    _persistenceEnabled = true;
  }
  return _persistenceEnabled;
}

/**
 * Enable or disable device-scoped persistence.
 * @param {boolean} enabled
 */
export function setDevicePersistenceEnabled(enabled) {
  _persistenceEnabled = enabled;
  try {
    localStorage.setItem(DEVICE_PERSISTENCE_KEY, String(enabled));
  } catch { /* quota exceeded, non-critical */ }
}

/**
 * Get the active storage keys (device-scoped or global).
 * @returns {{ current: string, previous: string }}
 */
export function getStorageKeys() {
  if (isDevicePersistenceEnabled()) {
    const fp = getDeviceFingerprint();
    return {
      current: `${STORAGE_KEY_BASE}_${fp}`,
      previous: `${STORAGE_KEY_BASE_PREV}_${fp}`,
    };
  }
  return { current: STORAGE_KEY_BASE, previous: STORAGE_KEY_BASE_PREV };
}

/**
 * Convert Float32Array to plain array for JSON serialization.
 * @param {Float32Array} float32Array
 * @returns {number[]}
 */
export function float32ToArray(float32Array) {
  return Array.from(float32Array);
}

/**
 * Convert plain array back to Float32Array.
 * @param {number[]} arr
 * @returns {Float32Array}
 */
export function arrayToFloat32(arr) {
  return new Float32Array(arr);
}

/**
 * Check if all 8 ISO bands are saturated at ±4dB limits.
 * @param {Float32Array|number[]} gains
 * @returns {boolean}
 */
export function isProfileSaturated(gains) {
  if (!gains || gains.length === 0) return false;
  for (let i = 0; i < gains.length; i++) {
    const g = gains[i];
    if (g > -4.0 && g < 4.0) return false;
  }
  return true;
}

/**
 * Save a calibration profile to localStorage using dual-slot persistence.
 * Moves current → previous, then saves new → current.
 * If the new profile is saturated (all bands at ±4dB) and a previous exists,
 * auto-rollback: restore previous → current.
 *
 * @param {{gains: Float32Array|null, timestamp: number, type: string, bands?: {freq: number, gain: number, Q: number}[]}} profile
 * @returns {{rolledBack: boolean}}
 */
export function saveProfile(profile) {
  const { current, previous } = getStorageKeys();
  const serializable = {
    gains: profile.gains ? Array.from(profile.gains) : null,
    timestamp: profile.timestamp,
    type: profile.type,
    bands: profile.bands || undefined,
  };

  // Move current → previous
  const currentRaw = localStorage.getItem(current);
  if (currentRaw) {
    localStorage.setItem(previous, currentRaw);
  }

  // Check saturation: if all bands at ±4dB and previous exists, rollback
  if (profile.gains && isProfileSaturated(profile.gains) && currentRaw) {
    // Restore current (previous was already set to the old current — keep it)
    localStorage.setItem(current, currentRaw);
    return { rolledBack: true };
  }

  // Normal save: new → current
  localStorage.setItem(current, JSON.stringify(serializable));
  return { rolledBack: false };
}

/**
 * Load a calibration profile from localStorage (current slot).
 * @returns {{gains: Float32Array|null, timestamp: number, type: string, bands?: {freq: number, gain: number, Q: number}[]}|null}
 */
export function loadProfile() {
  return _loadFromKey(getStorageKeys().current);
}

/**
 * Load the previous calibration profile from localStorage.
 * @returns {{gains: Float32Array|null, timestamp: number, type: string, bands?: {freq: number, gain: number, Q: number}[]}|null}
 */
export function loadPreviousProfile() {
  return _loadFromKey(getStorageKeys().previous);
}

/**
 * Export the current calibration profile as a JSON string.
 * Includes metadata for cross-device portability.
 * @returns {string|null} JSON string or null if no profile exists
 */
export function exportProfile() {
  const profile = loadProfile();
  if (!profile) return null;

  const exportData = {
    format: 'lazyEq-profile-v1',
    exportedAt: Date.now(),
    deviceFingerprint: getDeviceFingerprint(),
    calibration: {
      gains: profile.gains ? Array.from(profile.gains) : null,
      timestamp: profile.timestamp,
      type: profile.type,
      bands: profile.bands || undefined,
    },
  };

  return JSON.stringify(exportData, null, 2);
}

/**
 * Import a calibration profile from a JSON string.
 * Supports lazyEq-profile-v1 format and legacy raw format.
 * @param {string} jsonString
 * @returns {{ success: boolean, type: string|null, bandsCount: number|null }}
 */
export function importProfile(jsonString) {
  try {
    const data = JSON.parse(jsonString);

    let profile;
    // New v1 format with metadata
    if (data.format === 'lazyEq-profile-v1' && data.calibration) {
      profile = data.calibration;
    }
    // Legacy raw profile format (backward compat)
    else if (data.type && (data.type === 'pink-noise' || data.type === 'sweep')) {
      profile = data;
    } else {
      return { success: false, type: null, bandsCount: null };
    }

    // Validate required fields: must be array of exactly 8 finite numbers
    if (!Array.isArray(profile.gains) || typeof profile.timestamp !== 'number') {
      return { success: false, type: null, bandsCount: null };
    }
    if (profile.gains.length !== 8 || !profile.gains.every(g => typeof g === 'number' && isFinite(g))) {
      return { success: false, type: null, bandsCount: null };
    }

    const bands = Array.isArray(profile.bands) ? profile.bands : [];

    const saveResult = saveProfile({
      gains: new Float32Array(profile.gains),
      timestamp: profile.timestamp,
      type: profile.type,
      bands: bands.length > 0 ? bands : undefined,
    });

    if (saveResult.rolledBack) {
      return { success: true, rolledBack: true, type: profile.type, bandsCount: bands.length };
    }

    return { success: true, type: profile.type, bandsCount: bands.length };
  } catch {
    return { success: false, type: null, bandsCount: null };
  }
}

/**
 * Internal helper: load and parse a profile from a given storage key.
 * @param {string} key
 * @returns {{gains: Float32Array|null, timestamp: number, type: string, bands?: {freq: number, gain: number, Q: number}[]}|null}
 */
function _loadFromKey(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw);

    // Validate shape
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.timestamp !== 'number') return null;
    if (typeof parsed.type !== 'string') return null;
    if (parsed.type !== 'pink-noise' && parsed.type !== 'sweep') return null;

    // Reconstruct Float32Array
    const gains = Array.isArray(parsed.gains)
      ? new Float32Array(parsed.gains)
      : null;

    // Reconstruct bands if present (optional field)
    const bands = Array.isArray(parsed.bands) ? parsed.bands : undefined;

    return { gains, timestamp: parsed.timestamp, type: parsed.type, bands };
  } catch {
    // Corrupt or unreadable data
    return null;
  }
}
