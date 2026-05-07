/**
 * Persistence — save/load calibration profiles to localStorage.
 *
 * Profile shape: { gains: Float32Array|null, timestamp: number, type: 'pink-noise'|'sweep', bands?: ParametricBand[] }
 *
 * Float32Array is converted to a plain Array for JSON serialization.
 * ParametricBand[] is serialized as a plain array of {freq, gain, Q} objects.
 */

const STORAGE_KEY = 'lazyEq_calibration';
const STORAGE_KEY_PREV = 'lazyEq_calibration_prev';

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
  const serializable = {
    gains: profile.gains ? Array.from(profile.gains) : null,
    timestamp: profile.timestamp,
    type: profile.type,
    bands: profile.bands || undefined,
  };

  // Move current → previous
  const current = localStorage.getItem(STORAGE_KEY);
  if (current) {
    localStorage.setItem(STORAGE_KEY_PREV, current);
  }

  // Check saturation: if all bands at ±4dB and previous exists, rollback
  if (profile.gains && isProfileSaturated(profile.gains) && current) {
    // Restore previous → current (auto-rollback)
    localStorage.setItem(STORAGE_KEY, current);
    return { rolledBack: true };
  }

  // Normal save: new → current
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  return { rolledBack: false };
}

/**
 * Load a calibration profile from localStorage (current slot).
 * @returns {{gains: Float32Array|null, timestamp: number, type: string, bands?: {freq: number, gain: number, Q: number}[]}|null}
 */
export function loadProfile() {
  return _loadFromKey(STORAGE_KEY);
}

/**
 * Load the previous calibration profile from localStorage.
 * @returns {{gains: Float32Array|null, timestamp: number, type: string, bands?: {freq: number, gain: number, Q: number}[]}|null}
 */
export function loadPreviousProfile() {
  return _loadFromKey(STORAGE_KEY_PREV);
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
