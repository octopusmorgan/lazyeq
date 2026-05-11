/**
 * Parametric EQ Synthesizer for Pink Noise Smart Correction.
 *
 * Converts ranked candidates into parametric EQ bands with proper gain clamping,
 * Q computation, and curve evaluation using the RBJ peaking filter magnitude formula.
 */

import {
  MAX_CUT_DB,
  MAX_BOOST_DB,
  BOOST_CONFIDENCE_THRESHOLD,
  BOOST_PENALTY,
  Q_MIN,
  Q_MAX,
  MAX_PARAMETRIC_BANDS,
  LF_FOCUS_CUTOFF,
  LF_MAX_Q,
} from './constants.js';

/**
 * @typedef {Object} ParametricBand
 * @property {number} freq - Center frequency in Hz
 * @property {number} gain - Gain in dB (negative = cut, positive = boost)
 * @property {number} Q - Quality factor
 */

/**
 * Synthesize parametric EQ bands from ranked candidates.
 * @param {Object[]} candidates - From rankCandidates
 * @param {number[]} [targetFrequencies] - Frequencies to evaluate curve at (for export)
 * @param {Object} [options] - Override limits, Q bounds, boost policy
 * @returns {{ bands: ParametricBand[], gains: Float32Array }}
 */
export function synthesizeBands(candidates, targetFrequencies, options = {}) {
  // Guard: bad input
  if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
    const len = targetFrequencies ? targetFrequencies.length : 0;
    return {
      bands: [],
      gains: len > 0 ? new Float32Array(len) : new Float32Array(0),
    };
  }

  const maxCut = options.maxCutDb ?? MAX_CUT_DB;
  const maxBoost = options.maxBoostDb ?? MAX_BOOST_DB;
  const boostConfThresh = options.boostConfidenceThreshold ?? BOOST_CONFIDENCE_THRESHOLD;
  const boostPenalty = options.boostPenalty ?? BOOST_PENALTY;
  const qMin = options.qMin ?? Q_MIN;
  const qMax = options.qMax ?? Q_MAX;
  const lfCutoff = options.lfCutoff ?? LF_FOCUS_CUTOFF;
  const lfMaxQ = options.lfMaxQ ?? LF_MAX_Q;
  const maxBands = options.maxBands ?? MAX_PARAMETRIC_BANDS;

  // Take top candidates
  const top = candidates.slice(0, maxBands);

  // Synthesize bands
  const bands = [];
  for (const c of top) {
    // Gain = -deviationDb (negative because we correct the deviation)
    // Standard EQ convention: negative gain = cut, positive gain = boost
    let gain = -c.deviationDb;

    if (gain < 0) {
      // Cut: clamp magnitude to maxCut (gain stays negative)
      gain = Math.max(gain, -maxCut);
    } else {
      // Boost: clamp to maxBoost
      gain = Math.min(gain, maxBoost);
      // Apply boost penalty if confidence is low
      if ((c.confidence ?? 1) < boostConfThresh) {
        gain *= boostPenalty;
      }
    }

    // Q = freq / widthHz, clamped
    let q = c.freq / Math.max(c.widthHz, 0.1);
    q = Math.max(qMin, Math.min(qMax, q));

    // LF Q cap
    if (c.freq < lfCutoff && q > lfMaxQ) {
      q = lfMaxQ;
    }

    bands.push({ freq: c.freq, gain, Q: q });
  }

  // Merge candidates within 1 octave
  const merged = mergeBandsWithinOctave(bands);

  // Compute gains if targetFrequencies provided
  let gains;
  if (targetFrequencies && targetFrequencies.length > 0) {
    gains = gainsFromBands(merged, targetFrequencies);
  } else {
    gains = new Float32Array(0);
  }

  return { bands: merged, gains };
}

/**
 * Merge bands only when they are very close and same-polarity:
 * - proximity: within 1/2 octave
 * - polarity: both cut or both boost
 * This preserves nearby-but-distinct corrections instead of collapsing them too early.
 */
function mergeBandsWithinOctave(bands) {
  if (bands.length <= 1) return bands;

  const sorted = [...bands].sort((a, b) => a.freq - b.freq);
  const result = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = result[result.length - 1];
    const curr = sorted[i];

    const samePolarity = Math.sign(curr.gain) === Math.sign(prev.gain);
    // Check if within 1/2 octave: curr.freq / prev.freq <= 2^(1/2)
    if (samePolarity && (curr.freq / prev.freq <= Math.sqrt(2))) {
      // Keep the one with higher |gain|
      if (Math.abs(curr.gain) > Math.abs(prev.gain)) {
        result[result.length - 1] = curr;
      }
    } else {
      result.push(curr);
    }
  }

  return result;
}

/**
 * Evaluate the combined magnitude response of parametric bands at given frequencies.
 * Uses the RBJ peaking filter magnitude formula.
 * @param {ParametricBand[]} bands
 * @param {number[]} frequencies - Hz values
 * @returns {Float32Array} dB values at each frequency
 */
export function evaluateCurveAt(bands, frequencies) {
  if (!frequencies || frequencies.length === 0) {
    return new Float32Array(0);
  }

  const n = frequencies.length;
  const result = new Float32Array(n);

  if (!bands || bands.length === 0) {
    return result; // already zero-filled
  }

  for (let i = 0; i < n; i++) {
    const f = frequencies[i];
    let totalDb = 0;

    for (const band of bands) {
      const A = Math.pow(10, band.gain / 40); // 10^(gain/(2*20))
      const ratio = f / band.freq;
      const ratioSq = ratio * ratio;
      const oneMinusRatioSq = 1 - ratioSq;

      // RBJ peaking filter magnitude squared:
      // |H|² = [(1-Ω²)² + (A·Ω/Q)²] / [(1-Ω²)² + (Ω/(A·Q))²]
      const num = oneMinusRatioSq * oneMinusRatioSq + (A * ratio / band.Q) * (A * ratio / band.Q);
      const den = oneMinusRatioSq * oneMinusRatioSq + (ratio / (A * band.Q)) * (ratio / (A * band.Q));

      if (den > 0) {
        const magnitude = Math.sqrt(num / den);
        if (magnitude > 0) {
          totalDb += 20 * Math.log10(magnitude);
        }
      }
    }

    result[i] = totalDb;
  }

  return result;
}

/**
 * Produce per-point gains array for export/visualization.
 * @param {ParametricBand[]} bands
 * @param {number[]} targetFreqs - Frequencies to evaluate at
 * @returns {Float32Array}
 */
export function gainsFromBands(bands, targetFreqs) {
  if (!targetFreqs || targetFreqs.length === 0) {
    return new Float32Array(0);
  }
  return evaluateCurveAt(bands, targetFreqs);
}
