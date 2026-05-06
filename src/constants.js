/**
 * Constants for lazyEq - Centralized configuration values
 */

// Audio configuration
export const SAMPLE_RATE = 44100;
export const FFT_SIZE = 2048;

// Microphone reference offset (dB) - calibrated silence level
export const MIC_REFERENCE_OFFSET = 90;

// Pink noise calibration
export const PINK_NOISE_BUFFER_SECS = 10;
export const PINK_NOISE_GAIN = 0.65;
export const MEASUREMENT_INTERVAL_MS = 500;
export const CONVERGENCE_THRESHOLD_DB = 0.5;
export const CONVERGENCE_WINDOW_COUNT = 3;

// Stability gating (Phase 2)
export const SNR_THRESHOLD_DB = 10;
export const MIN_MEASUREMENTS = 4;
export const CALIBRATION_TIMEOUT_MS = 30000;
export const SILENCE_THRESHOLD_DB = -70;

// Adaptive per-band gain limits (Phase 3)
export const INITIAL_PER_BAND_GAIN = 6;
export const SATURATION_RATIO_THRESHOLD = 0.35;
export const SATURATION_CONSECUTIVE_COUNT = 2;