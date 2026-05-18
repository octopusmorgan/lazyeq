/**
 * Constants for lazyEq - Centralized configuration values
 */

// Audio configuration
export const SAMPLE_RATE = 44100;
export const FFT_SIZE = 8192;

// Microphone reference offset (dB) - calibrated silence level
export const MIC_REFERENCE_OFFSET = 90;

// Pink noise calibration
export const PINK_NOISE_BUFFER_SECS = 10;
export const PINK_NOISE_GAIN = 0.95;
export const MEASUREMENT_INTERVAL_MS = 500;
export const MIN_MEASUREMENTS = 30;    // 15s minimum (30 × 500ms windows)
export const CALIBRATION_TIMEOUT_MS = 30000; // 30s = 2x minimum time
export const CONVERGENCE_THRESHOLD_DB = 1.0;
export const CONVERGENCE_WINDOW_COUNT = 5;

// Stability gating (Phase 2)
export const SNR_THRESHOLD_DB = 10;
export const SILENCE_THRESHOLD_DB = -70;

// Adaptive per-band gain limits (Phase 3)
export const INITIAL_PER_BAND_GAIN = 6;
export const SATURATION_RATIO_THRESHOLD = 0.35;
export const SATURATION_CONSECUTIVE_COUNT = 2;

// Smart Correction — Candidate Detection
export const PEAK_DETECTION_THRESHOLD = 2.0;   // dB above target to count as peak
export const NULL_DETECTION_THRESHOLD = 2.0;    // dB below target to count as null
export const NULL_REJECTION_WIDTH_HZ = 0;      // 0 = auto (freq/3 = 1/3 octave)
export const MERGE_DISTANCE_HZ = 0;            // 0 = auto (1/6 octave)
export const CONFIDENCE_SNR_THRESHOLD = 6;     // dB minimum SNR for high confidence
export const EFFECTIVE_RANGE = Object.freeze({ low: 100, high: 8000 }); // Hz range for candidate detection (Bluetooth speakers)

// Smart Correction — Candidate Ranking
export const RANKING_WEIGHTS = Object.freeze({
  deviation: 1.0,
  stability: 0.6,
  bandwidth: 0.4,
  narrowness: 0.8,
  lowConfidence: 0.5,
});
export const LF_FOCUS_MULTIPLIER = 1.5;
export const LF_FOCUS_CUTOFF = 300;   // Hz

// Smart Correction — Parametric EQ Synthesis
export const MAX_CUT_DB = 6;
export const MAX_BOOST_DB = 3;
export const BOOST_CONFIDENCE_THRESHOLD = 0.7;
export const BOOST_PENALTY = 0.5;           // reduce boost by 50% if confidence < threshold
export const Q_MIN = 0.5;
export const Q_MAX = 4.0;
export const MAX_PARAMETRIC_BANDS = 16;
export const LF_MAX_Q = 2.0;                // cap Q for bands below LF_FOCUS_CUTOFF

// Smart Correction — Filter Pool
export const FILTER_POOL_SIZE = 16;
export const FILTER_POOL_SMOOTHING = 0.05;  // timeConstant for setTargetAtTime
// Convergence evaluation frequencies (core mid-bands where correction is most reliable)
export const EVAL_FREQUENCIES = Object.freeze([125, 250, 500, 1000, 2000, 4000, 8000]);
// Maximum allowed residual (target - estimated response) at EVAL_FREQUENCIES for convergence
export const SMART_RESIDUAL_THRESHOLD_DB = 3.5;

// Smart Correction — Feature Flag
export const USE_SMART_CORRECTION = typeof window !== 'undefined'
  ? localStorage.getItem('lazyeq.useSmartCorrection') !== 'false'
  : true; // runtime toggle for rollback

// Smart Correction — Signal Level Guard
export const MIN_SIGNAL_LEVEL_DB = -80;      // below this, warn user the mic isn't receiving the speaker
export const LOW_SIGNAL_WINDOW_COUNT = 6;    // consecutive windows before warning (~3s at 500ms)

// Calibration console diagnostics (see src/calibrationDebugLog.js)
// Also: localStorage.setItem('lazyeq.calibrationDebug','1') or window.__LAZYEQ_CALIBRATION_DEBUG__ = true
export const CALIBRATION_DEBUG = typeof window !== 'undefined'
  ? localStorage.getItem('lazyeq.calibrationDebug') === '1' || window.__LAZYEQ_CALIBRATION_DEBUG__ === true
  : false;
export const CALIBRATION_DEBUG_INTERVAL_MS = 500;
export const CALIBRATION_DEBUG_KEY_FREQS = Object.freeze([
  63, 125, 250, 500, 1000, 2000, 4000, 8000, 10000, 16000,
]);

// Legacy 8-band EQ frequencies (used by _processMeasurementResults per-band smart correction)
export const ACTIVE_EQ_FREQS = Object.freeze([63, 125, 250, 500, 1000, 2000, 4000, 8000]);
