/**
 * Candidate Detection for Pink Noise Smart Correction.
 *
 * Detects local maxima (peaks) and minima (nulls) in a smoothed frequency
 * response relative to a target curve. Computes bandwidth, confidence, and
 * merges nearby candidates.
 */

import {
  PEAK_DETECTION_THRESHOLD,
  NULL_DETECTION_THRESHOLD,
  NULL_REJECTION_WIDTH_HZ,
  MERGE_DISTANCE_HZ,
  EFFECTIVE_RANGE,
} from './constants.js';

/**
 * @typedef {Object} Candidate
 * @property {number} freq - Center frequency in Hz
 * @property {number} deviationDb - Positive for peaks, negative for nulls
 * @property {'peak'|'null'} type
 * @property {number} widthHz - Bandwidth at half-deviation
 * @property {number} confidence - 0-1 estimated confidence from spectral flatness
 * @property {number} atIndex - Index in the original arrays
 */

/**
 * Detect correction candidates from a smoothed frequency response.
 * @param {Float32Array} response - dB values at each frequency point
 * @param {Float32Array} target - dB target curve at each frequency point
 * @param {number[]} frequencies - Hz values for each point
 * @param {Object} [options] - Override constants
 * @param {Float32Array} [options.rawSpectrum] - Pre-smoothing spectrum for confidence
 * @param {Object} [options.effectiveRange] - {low, high} Hz range for candidate detection
 * @returns {Candidate[]}
 */
export function detectCandidates(response, target, frequencies, options = {}) {
  // Guard: bad input
  if (!response || !target || !frequencies ||
      response.length === 0 || target.length === 0 || frequencies.length === 0 ||
      response.length !== target.length || response.length !== frequencies.length) {
    return [];
  }

  const n = response.length;

  // Validate no NaN
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(response[i]) || Number.isNaN(target[i]) || Number.isNaN(frequencies[i])) {
      return [];
    }
  }

  const peakThreshold = options.peakThreshold ?? PEAK_DETECTION_THRESHOLD;
  const nullThreshold = options.nullThreshold ?? NULL_DETECTION_THRESHOLD;
  const mergeDist = options.mergeDistance ?? MERGE_DISTANCE_HZ;
  const nullRejectionWidth = options.nullRejectionWidth ?? NULL_REJECTION_WIDTH_HZ;
  const rawSpectrum = options.rawSpectrum;
  const effectiveRange = options.effectiveRange ?? EFFECTIVE_RANGE;

  // Step 1: Compute deviation
  const deviation = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    deviation[i] = response[i] - target[i];
  }

  // Step 2: Find local maxima (peaks) and minima (nulls) within effective range
  const raw = [];
  for (let i = 1; i < n - 1; i++) {
    const freq = frequencies[i];
    // Skip frequencies outside effective range
    if (freq < effectiveRange.low || freq > effectiveRange.high) continue;

    const d = deviation[i];
    // Peak: local maximum above threshold
    if (d > deviation[i - 1] && d > deviation[i + 1] && d > peakThreshold) {
      raw.push({ freq, deviationDb: d, type: 'peak', atIndex: i });
    }
    // Null: local minimum below threshold
    if (d < deviation[i - 1] && d < deviation[i + 1] && d < -nullThreshold) {
      raw.push({ freq, deviationDb: d, type: 'null', atIndex: i });
    }
  }

  // Also check boundaries (first and last points) within effective range
  if (n >= 2) {
    if (frequencies[0] >= effectiveRange.low && frequencies[0] <= effectiveRange.high) {
      if (deviation[0] > deviation[1] && deviation[0] > peakThreshold) {
        raw.push({ freq: frequencies[0], deviationDb: deviation[0], type: 'peak', atIndex: 0 });
      }
      if (deviation[0] < deviation[1] && deviation[0] < -nullThreshold) {
        raw.push({ freq: frequencies[0], deviationDb: deviation[0], type: 'null', atIndex: 0 });
      }
    }
    if (frequencies[n - 1] >= effectiveRange.low && frequencies[n - 1] <= effectiveRange.high) {
      if (deviation[n - 1] > deviation[n - 2] && deviation[n - 1] > peakThreshold) {
        raw.push({ freq: frequencies[n - 1], deviationDb: deviation[n - 1], type: 'peak', atIndex: n - 1 });
      }
      if (deviation[n - 1] < deviation[n - 2] && deviation[n - 1] < -nullThreshold) {
        raw.push({ freq: frequencies[n - 1], deviationDb: deviation[n - 1], type: 'null', atIndex: n - 1 });
      }
    }
  }

  // Step 3: Measure bandwidth and compute confidence
  const candidates = [];
  for (const c of raw) {
    const halfDev = Math.abs(c.deviationDb) / 2;
    const sign = c.deviationDb > 0 ? 1 : -1;

    // Find left boundary: where |deviation| drops below half-deviation
    let leftIdx = c.atIndex;
    for (let i = c.atIndex - 1; i >= 0; i--) {
      if (deviation[i] * sign < halfDev) {
        leftIdx = i;
        break;
      }
      leftIdx = i;
    }

    // Find right boundary
    let rightIdx = c.atIndex;
    for (let i = c.atIndex + 1; i < n; i++) {
      if (deviation[i] * sign < halfDev) {
        rightIdx = i;
        break;
      }
      rightIdx = i;
    }

    const widthHz = frequencies[rightIdx] - frequencies[leftIdx];
    c.widthHz = Math.max(widthHz, 0.1); // avoid zero width

    // Confidence from spectral flatness in ±1 octave window
    c.confidence = computeConfidence(c.freq, frequencies, response, rawSpectrum);

    candidates.push(c);
  }

  // Step 4: Reject narrow nulls
  const filtered = candidates.filter((c) => {
    if (c.type !== 'null') return true;
    const minWidth = nullRejectionWidth > 0 ? nullRejectionWidth : c.freq / 3;
    return c.widthHz >= minWidth;
  });

  // Step 5: Merge nearby candidates
  return mergeCandidates(filtered, frequencies, mergeDist);
}

/**
 * Compute confidence from spectral flatness in ±1 octave around candidate freq.
 * Lower flatness (more tonal) = higher confidence. Higher flatness (noisy) = lower confidence.
 */
function computeConfidence(freq, frequencies, response, rawSpectrum) {
  const n = frequencies.length;
  const fLow = freq / 2;   // -1 octave
  const fHigh = freq * 2;  // +1 octave

  // Collect absolute response values in the window
  const values = [];
  for (let i = 0; i < n; i++) {
    if (frequencies[i] >= fLow && frequencies[i] <= fHigh) {
      const val = Math.abs(response[i]);
      if (val > 0) values.push(val);
    }
  }

  if (values.length < 2) return 0.5; // insufficient data, neutral confidence

  // Geometric mean via log
  const logSum = values.reduce((s, v) => s + Math.log(v), 0);
  const geometricMean = Math.exp(logSum / values.length);
  const arithmeticMean = values.reduce((s, v) => s + v, 0) / values.length;

  if (arithmeticMean === 0) return 0.5;

  // Spectral flatness: geometric / arithmetic (0 = tonal, 1 = noisy)
  const flatness = geometricMean / arithmeticMean;

  // Map to confidence: flat=0 → confidence=1, flat=1 → confidence=0
  return Math.max(0, Math.min(1, 1 - flatness));
}

/**
 * Merge candidates closer than merge distance, keeping higher |deviation|.
 */
function mergeCandidates(candidates, frequencies, mergeDist) {
  if (candidates.length === 0) return [];

  // Sort by frequency
  const sorted = [...candidates].sort((a, b) => a.freq - b.freq);
  const merged = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];

    // Compute merge distance based on geometric mean frequency
    const geoMean = Math.sqrt(prev.freq * curr.freq);
    const dist = mergeDist > 0 ? mergeDist : geoMean / 6; // 1/6 octave default
    const freqDiff = Math.abs(curr.freq - prev.freq);

    if (freqDiff <= dist) {
      // Merge: keep the one with higher |deviation|
      if (Math.abs(curr.deviationDb) > Math.abs(prev.deviationDb)) {
        merged[merged.length - 1] = curr;
      }
      // else keep prev (already in merged)
    } else {
      merged.push(curr);
    }
  }

  return merged;
}
