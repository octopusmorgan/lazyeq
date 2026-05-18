/**
 * Candidate Ranking for Pink Noise Smart Correction.
 *
 * Scores and sorts correction candidates by priority using weighted factors
 * including deviation magnitude, stability, bandwidth, narrowness, and confidence.
 */

import {
  RANKING_WEIGHTS,
  LF_FOCUS_MULTIPLIER,
  LF_FOCUS_CUTOFF,
  MAX_PARAMETRIC_BANDS,
} from './constants.js';

/**
 * @typedef {Object} RankedCandidate
 * @property {number} freq - Center frequency in Hz
 * @property {number} deviationDb - Positive for peaks, negative for nulls
 * @property {'peak'|'null'} type
 * @property {number} widthHz - Bandwidth at half-deviation
 * @property {number} confidence - 0-1 estimated confidence
 * @property {number} atIndex - Index in the original arrays
 * @property {number} score - Computed priority score
 * @property {number} rank - Position after sorting (1-based)
 * @property {number} stability - Stability factor (defaults to 1.0)
 */

/**
 * Rank correction candidates by priority score.
 * @param {Object[]} candidates - From detectCandidates
 * @param {Object} [options] - Override weights, LF focus params
 * @returns {RankedCandidate[]} Sorted by score descending
 */
export function rankCandidates(candidates, options = {}) {
  // Guard: bad input
  if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }

  const w = options.weights ?? RANKING_WEIGHTS;
  const lfMultiplier = options.lfMultiplier ?? LF_FOCUS_MULTIPLIER;
  const lfCutoff = options.lfCutoff ?? LF_FOCUS_CUTOFF;
  const maxBands = options.maxBands ?? MAX_PARAMETRIC_BANDS;

  const ranked = candidates.map((c) => {
    const stability = c.stability ?? 1.0;
    const bandwidthFactor = Math.log2(Math.max(c.widthHz, 1) / 20);
    const narrowness = 1 / Math.max(c.widthHz, 0.1);
    const confidencePenalty = 1 - (c.confidence ?? 0.5);

    // Narrow peaks/nulls should be prioritized (higher 1/width -> higher score).
    let score =
      w.deviation * Math.abs(c.deviationDb) +
      w.stability * stability +
      w.bandwidth * bandwidthFactor +
      w.narrowness * narrowness -
      w.lowConfidence * confidencePenalty;

    // LF focus: boost score for low-frequency candidates
    if (c.freq < lfCutoff) {
      score *= lfMultiplier;
    }

    return {
      ...c,
      score,
      stability,
    };
  });

  // Sort descending by score
  ranked.sort((a, b) => b.score - a.score);

  // Assign rank (1-based)
  ranked.forEach((c, i) => {
    c.rank = i + 1;
  });

  // Cap at max bands
  return ranked.slice(0, maxBands);
}
