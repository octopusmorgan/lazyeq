/**
 * CalibrationOrchestrator — pink-noise calibration lifecycle manager.
 *
 * Encapsulates the pink-noise calibration measurement loop from main.js
 * into a DI-friendly class. Zero behavioral changes.
 *
 * Communicates outward exclusively via constructor-injected callbacks — no DOM access.
 */

import { FILTER_POOL_SIZE, FILTER_POOL_SMOOTHING } from './constants.js';

export class CalibrationOrchestrator {
  /**
   * @param {Object} deps
   * @param {SpectrumAnalyzer} deps.analyzer — MUST be initialized before start()
   * @param {AudioContext} deps.audioContext — shared context (created by main.js)
   * @param {PinkNoiseSource} deps.pinkNoise — PinkNoiseSource factory/instance
   * @param {ConvergenceDetector} deps.convergence — ConvergenceDetector
   * @param {Function} deps.smartCorrection — runSmartCorrectionPipeline
   * @param {Object} deps.debugLog — { logWindow, logConverged, logError, enable }
   * @param {Function} [deps.onStatusChange] — ({ text, className }) => void
   * @param {Function} [deps.onRenderFrame] — (state) => void
   * @param {Function} [deps.onCalibrationResult] — (result, options) => void
   */
  constructor(deps) {
    // Required dep validation
    const required = ['analyzer', 'audioContext', 'pinkNoise', 'convergence', 'smartCorrection', 'debugLog'];
    for (const key of required) {
      if (!deps[key]) {
        throw new TypeError(`CalibrationOrchestrator: missing required dep "${key}"`);
      }
    }

    /** @private */
    this._deps = deps;

    // Optional callbacks — degrade silently when absent
    this._onStatusChange = typeof deps.onStatusChange === 'function' ? deps.onStatusChange : null;
    this._onRenderFrame = typeof deps.onRenderFrame === 'function' ? deps.onRenderFrame : null;
    this._onCalibrationResult = typeof deps.onCalibrationResult === 'function' ? deps.onCalibrationResult : null;

    // Shared constants (not DI'd — stable modules)
    this._ACTIVE_EQ_FREQS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

    // Initialize all state
    this._resetState();
  }

  // ── State Management ──────────────────────────────────────────────────

  /**
   * Reset all calibration state to defaults.
   * @private
   */
  _resetState() {
    this._pinkNoise = null;
    this._convergenceDetector = null;
    this._continuousMeasurement = null;
    this._liveSpectrum = null;
    this._liveVisData = null;
    this._liveEQGains = null;
    this._calibrationRunning = false;
    this._calibrationStartTime = 0;
    this._lowInputWarningCount = 0;
    this._lastMeasurementResult = null;
    this._previousCandidateFreqs = null;
    this._consecutiveLowSignalCount = 0;
    this._bestResult = null;
    this._bestMaxDelta = Infinity;
    this._validMeasurementCount = 0;
    this._consecutiveSNRSkips = 0;
    this._calibrationTimeout = null;
    this._activeEQFilters = null;
    this._cumulativeEQGains = null;
    this._currentParametricBands = null;
    this._perBandMaxGain = null;
    this._perBandMaxCut = null;
    this._perBandSaturationCount = null;
    this._prevBandCorrected = null;
  }

  // ── Public Accessors ──────────────────────────────────────────────────

  /**
   * Snapshot of live state for render loop.
   * @returns {{ running: boolean, liveVisData: Array|null, liveEQGains: Float32Array|null, lastResult: Object|null }}
   */
  getState() {
    return {
      running: this._calibrationRunning,
      liveVisData: this._liveVisData,
      liveEQGains: this._liveEQGains,
      lastResult: this._lastMeasurementResult,
    };
  }

  /** @returns {boolean} Whether calibration is currently active. */
  isRunning() {
    return this._calibrationRunning;
  }

  // ── Filter Pool ───────────────────────────────────────────────────────

  /**
   * Update the 16-filter pool with parametric EQ bands.
   * Unused slots are set to gain=0 (flat).
   * @param {Object[]} bands — ParametricBand[] from synthesizeBands
   */
  updateFilterPool(bands) {
    if (!this._activeEQFilters || this._activeEQFilters.length !== FILTER_POOL_SIZE) return;
    const t = this._deps.audioContext ? this._deps.audioContext.currentTime : 0;
    for (let i = 0; i < FILTER_POOL_SIZE; i++) {
      const filter = this._activeEQFilters[i];
      if (i < bands.length) {
        filter.frequency.setTargetAtTime(bands[i].freq, t, FILTER_POOL_SMOOTHING);
        filter.gain.setTargetAtTime(bands[i].gain, t, FILTER_POOL_SMOOTHING);
        filter.Q.setTargetAtTime(bands[i].Q, t, FILTER_POOL_SMOOTHING);
      } else {
        filter.gain.setTargetAtTime(0, t, FILTER_POOL_SMOOTHING);
      }
    }
  }

  // ── Lifecycle Methods (implemented in Phases 2-3) ─────────────────────

  /**
   * Begin calibration lifecycle. Idempotent if already running.
   * @returns {Promise<void>}
   */
  async start() {
    throw new Error('CalibrationOrchestrator.start() not yet implemented');
  }

  /**
   * Manual stop (user click, error, visibility). Idempotent.
   */
  stop() {
    throw new Error('CalibrationOrchestrator.stop() not yet implemented');
  }

  /**
   * Core measurement callback.
   * @param {{ spectrum: Float32Array, rms: number, elapsedMs: number }} result
   * @private
   */
  _onMeasurement(result) {
    throw new Error('CalibrationOrchestrator._onMeasurement() not yet implemented');
  }

  /**
   * Called when convergence is detected or timeout fires.
   * @param {Object} result
   * @param {{ timedOut?: boolean }} options
   * @private
   */
  _finish(result, options = {}) {
    throw new Error('CalibrationOrchestrator._finish() not yet implemented');
  }
}
