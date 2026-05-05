/**
 * ConvergenceDetector — rolling window convergence detection for EQ gains.
 *
 * Stores the last N EQ gain arrays. On each push, computes the mean
 * absolute difference between the current and previous gain arrays.
 * Converges when delta < threshold for (windowCount - 1) consecutive
 * comparisons.
 */

export class ConvergenceDetector {
  /**
   * @param {number} thresholdDb — max mean delta to consider converged (default 0.5)
   * @param {number} windowCount — number of windows to track (default 3)
   */
  constructor(thresholdDb = 0.5, windowCount = 3) {
    this._threshold = thresholdDb;
    this._windowCount = windowCount;
    this._windows = [];
  }

  /**
   * Push a new EQ gain array and check convergence.
   * @param {Float32Array} gains
   * @returns {{converged: boolean, delta: number}}
   */
  push(gains) {
    // Clone to avoid mutation
    this._windows.push(Float32Array.from(gains));

    // Trim to window count
    if (this._windows.length > this._windowCount) {
      this._windows.shift();
    }

    // Need at least 2 windows to compute a delta
    if (this._windows.length < 2) {
      return { converged: false, delta: 0 };
    }

    const current = this._windows[this._windows.length - 1];
    const previous = this._windows[this._windows.length - 2];
    const len = current.length;

    let sum = 0;
    for (let i = 0; i < len; i++) {
      sum += Math.abs(current[i] - previous[i]);
    }
    const delta = sum / len;

    // Check if all recent comparisons are below threshold
    const consecutiveStable = this._countConsecutiveStable();
    const converged = consecutiveStable >= this._windowCount - 1 && delta < this._threshold;

    return { converged, delta };
  }

  /**
   * Count consecutive comparisons below threshold.
   * @returns {number}
   * @private
   */
  _countConsecutiveStable() {
    let count = 0;
    for (let i = this._windows.length - 1; i > 0; i--) {
      const current = this._windows[i];
      const previous = this._windows[i - 1];
      const len = current.length;
      let sum = 0;
      for (let j = 0; j < len; j++) {
        sum += Math.abs(current[j] - previous[j]);
      }
      const d = sum / len;
      if (d < this._threshold) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * Reset all stored windows.
   */
  reset() {
    this._windows = [];
  }

  /**
   * Get the number of stored windows.
   * @returns {number}
   */
  get windowCount() {
    return this._windows.length;
  }
}
