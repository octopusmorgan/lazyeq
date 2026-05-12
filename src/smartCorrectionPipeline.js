/**
 * Smart Correction Pipeline
 * Orchestrates the detect → rank → synthesize → evaluate pipeline for parametric EQ.
 */

import { detectCandidates } from './candidateDetector.js';
import { rankCandidates } from './candidateRanker.js';
import { synthesizeBands, evaluateCurveAt } from './parametricEqSynthesizer.js';
import {
  PEAK_DETECTION_THRESHOLD,
  NULL_DETECTION_THRESHOLD,
  NULL_REJECTION_WIDTH_HZ,
  MERGE_DISTANCE_HZ,
  RANKING_WEIGHTS,
  LF_FOCUS_MULTIPLIER,
  LF_FOCUS_CUTOFF,
  MAX_CUT_DB,
  MAX_BOOST_DB,
  BOOST_CONFIDENCE_THRESHOLD,
  BOOST_PENALTY,
  Q_MIN,
  Q_MAX,
  MAX_PARAMETRIC_BANDS,
  LF_MAX_Q,
  EVAL_FREQUENCIES,
} from './constants.js';

/**
 * Log-frequency interpolation helper for visualization/correction arrays.
 * @param {number[]} freqs
 * @param {Float32Array|number[]} values
 * @param {number} targetFreq
 * @returns {number}
 */
export function interpolateLogFreqValue(freqs, values, targetFreq) {
  if (!freqs || !values || freqs.length === 0 || values.length === 0) return 0;
  if (targetFreq <= freqs[0]) return values[0] ?? 0;
  if (targetFreq >= freqs[freqs.length - 1]) return values[values.length - 1] ?? 0;

  const logTarget = Math.log10(targetFreq);
  let lo = 0, hi = freqs.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (Math.log10(freqs[mid]) <= logTarget) lo = mid;
    else hi = mid;
  }

  const fLo = freqs[lo];
  const fHi = freqs[hi];
  if (fHi <= fLo) return values[lo] ?? 0;

  const t = (logTarget - Math.log10(fLo)) / (Math.log10(fHi) - Math.log10(fLo));
  const yLo = values[lo] ?? 0;
  const yHi = values[hi] ?? yLo;
  return yLo * (1 - t) + yHi * t;
}

/**
 * Residual severity used for convergence should reflect what EQ can safely fix.
 * Positive residual needs boost; negative residual needs cut. Severe nulls/rolloff
 * beyond max boost are treated as uncorrectable instead of blocking convergence.
 */
export function getCorrectableResidualSeverity(residuals) {
  let max = 0;
  for (const residual of residuals) {
    if (!Number.isFinite(residual)) continue;
    const limit = residual > 0 ? MAX_BOOST_DB : MAX_CUT_DB;
    max = Math.max(max, Math.min(Math.abs(residual), limit));
  }
  return max;
}

/**
 * Process pink noise measurement through the smart correction pipeline:
 * detect → rank → synthesize → evaluate.
 *
 * @param {Float32Array} normalizedResponse - Smoothed, normalized response (64 pts)
 * @param {Float32Array} targetCurve - Target dB at each point
 * @param {number[]} frequencies - Hz labels matching response/target
 * @param {number[]|null} previousCandidateFreqs - Freqs from previous window for stability tracking
 * @returns {{ bands: ParametricBand[], gains: Float32Array, evalGains: Float32Array, evalResiduals: Float32Array, candidates: RankedCandidate[], maxResidual: number, rawMaxResidual: number, passName: string, pipelineStats: Object }}
 */
export function runSmartCorrectionPipeline(normalizedResponse, targetCurve, frequencies, previousCandidateFreqs = null) {
  const RELAXED_PASS_TRIGGER_MAX_RESIDUAL_DB = 10;
  const RELAXED_PASS_MIN_BANDS = 2;

  const runPass = ({ peakThreshold, nullThreshold, mergeDivisor, passName }) => {
    const detectorStats = {};
    const candidates = detectCandidates(normalizedResponse, targetCurve, frequencies, {
      peakThreshold,
      nullThreshold,
      nullRejectionWidth: NULL_REJECTION_WIDTH_HZ,
      mergeDistance: MERGE_DISTANCE_HZ,
      mergeDivisor,
      effectiveRange: { low: 100, high: 8000 },
      debugStats: detectorStats,
    });

    if (previousCandidateFreqs && previousCandidateFreqs.length > 0) {
      for (const c of candidates) {
        const isPersistent = previousCandidateFreqs.some(
          prevFreq => Math.abs(c.freq - prevFreq) / Math.max(prevFreq, 20) < 0.3
        );
        c.stability = isPersistent ? 1.5 : 0.7;
      }
    }

    const rankedCandidates = rankCandidates(candidates, {
      weights: RANKING_WEIGHTS,
      lfMultiplier: LF_FOCUS_MULTIPLIER,
      lfCutoff: LF_FOCUS_CUTOFF,
      maxBands: MAX_PARAMETRIC_BANDS,
    });

    const { bands, gains } = synthesizeBands(rankedCandidates, frequencies, {
      maxCutDb: MAX_CUT_DB,
      maxBoostDb: MAX_BOOST_DB,
      boostConfidenceThreshold: BOOST_CONFIDENCE_THRESHOLD,
      boostPenalty: BOOST_PENALTY,
      qMin: Q_MIN,
      qMax: Q_MAX,
      maxBands: MAX_PARAMETRIC_BANDS,
      lfMaxQ: LF_MAX_Q,
      lfCutoff: LF_FOCUS_CUTOFF,
    });

    const evalGains = evaluateCurveAt(bands, EVAL_FREQUENCIES);
    const evalResiduals = new Float32Array(EVAL_FREQUENCIES.length);
    for (let i = 0; i < EVAL_FREQUENCIES.length; i++) {
      const freq = EVAL_FREQUENCIES[i];
      const responseAtFreq = interpolateLogFreqValue(frequencies, normalizedResponse, freq);
      const targetAtFreq = interpolateLogFreqValue(frequencies, targetCurve, freq);
      const estimatedAfterEq = responseAtFreq + evalGains[i];
      evalResiduals[i] = targetAtFreq - estimatedAfterEq;
    }

    const rawMaxResidual = Math.max(...Array.from(evalResiduals).map(Math.abs));
    const maxResidual = getCorrectableResidualSeverity(evalResiduals);

    return {
      passName,
      bands,
      gains,
      evalGains,
      evalResiduals,
      rawMaxResidual,
      candidates: rankedCandidates,
      pipelineStats: {
        rawCandidates: detectorStats.rawCount ?? 0,
        afterWidthReject: detectorStats.afterWidthRejectCount ?? 0,
        afterMerge: detectorStats.afterMergeCount ?? 0,
        ranked: rankedCandidates.length,
        bands: bands.length,
      },
      maxResidual,
    };
  };

  const primary = runPass({
    peakThreshold: PEAK_DETECTION_THRESHOLD,
    nullThreshold: NULL_DETECTION_THRESHOLD,
    mergeDivisor: 6,
    passName: 'primary',
  });

  let chosen = primary;

  const shouldRunRelaxed =
    primary.rawMaxResidual > RELAXED_PASS_TRIGGER_MAX_RESIDUAL_DB &&
    primary.bands.length <= 1;

  if (shouldRunRelaxed) {
    const relaxed = runPass({
      peakThreshold: Math.max(1.25, PEAK_DETECTION_THRESHOLD - 0.5),
      nullThreshold: Math.max(1.25, NULL_DETECTION_THRESHOLD - 0.5),
      mergeDivisor: 10,
      passName: 'relaxed',
    });

    const relaxedIsBetter =
      relaxed.maxResidual < primary.maxResidual ||
      (relaxed.bands.length >= RELAXED_PASS_MIN_BANDS && relaxed.maxResidual <= primary.maxResidual + 1.0) ||
      (relaxed.bands.length > primary.bands.length && relaxed.maxResidual <= primary.maxResidual + 0.6);

    if (relaxedIsBetter) {
      chosen = relaxed;
    }
  }

  return chosen;
}