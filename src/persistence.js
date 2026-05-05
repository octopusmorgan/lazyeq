/**
 * Persistence — save/load calibration profiles to localStorage.
 *
 * Profile shape: { gains: Float32Array|null, timestamp: number, type: 'pink-noise'|'sweep' }
 *
 * Float32Array is converted to a plain Array for JSON serialization.
 */

const STORAGE_KEY = 'lazyEq_calibration';

/**
 * Save a calibration profile to localStorage.
 * @param {{gains: Float32Array|null, timestamp: number, type: string}} profile
 */
export function saveProfile(profile) {
  const serializable = {
    gains: profile.gains ? Array.from(profile.gains) : null,
    timestamp: profile.timestamp,
    type: profile.type,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
}

/**
 * Load a calibration profile from localStorage.
 * @returns {{gains: Float32Array|null, timestamp: number, type: string}|null}
 */
export function loadProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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

    return { gains, timestamp: parsed.timestamp, type: parsed.type };
  } catch {
    // Corrupt or unreadable data
    return null;
  }
}
