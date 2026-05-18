/**
 * CalibrationOrchestrator — pink-noise calibration lifecycle manager.
 *
 * Encapsulates the pink-noise calibration measurement loop from main.js
 * into a DI-friendly class. Zero behavioral changes.
 *
 * Communicates outward exclusively via constructor-injected callbacks — no DOM access.
 */

import { PinkNoiseSource } from './pinkNoise.js';
import { ConvergenceDetector } from './convergence.js';
import { runSmartCorrectionPipeline } from './smartCorrectionPipeline.js';
import { saveProfile, float32ToArray } from './persistence.js';
import {
  logCalibrationWindow,
  enableCalibrationLog,
  logCalibrationError,
  logCalibrationConverged,
  isCalibrationDebugEnabled,
} from './calibrationDebugLog.js';
import { getHarmanTargetDB } from './eqGenerator.js';
import {
  FILTER_POOL_SIZE,
  FILTER_POOL_SMOOTHING,
  MEASUREMENT_INTERVAL_MS,
  CONVERGENCE_THRESHOLD_DB,
  CONVERGENCE_WINDOW_COUNT,
  SNR_THRESHOLD_DB,
  MIN_MEASUREMENTS,
  CALIBRATION_TIMEOUT_MS,
  SILENCE_THRESHOLD_DB,
  INITIAL_PER_BAND_GAIN,
  SATURATION_RATIO_THRESHOLD,
  SATURATION_CONSECUTIVE_COUNT,
  LOW_SIGNAL_WINDOW_COUNT,
  EVAL_FREQUENCIES,
  SMART_RESIDUAL_THRESHOLD_DB,
  USE_SMART_CORRECTION,
} from './constants.js';

export class CalibrationOrchestrator {
  constructor(deps) {
    const required = ['analyzer', 'audioContext', 'processMeasurement'];
    for (const key of required) {
      if (!deps[key]) {
        throw new TypeError(`CalibrationOrchestrator: missing required dep "${key}"`);
      }
    }

    this._deps = deps;

    this._onStatusChange = typeof deps.onStatusChange === 'function' ? deps.onStatusChange : null;
    this._onProgress = typeof deps.onProgress === 'function' ? deps.onProgress : null;
    this._onComplete = typeof deps.onComplete === 'function' ? deps.onComplete : null;

    this._ACTIVE_EQ_FREQS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

    this._resetState();
  }

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

  getState() {
    return {
      running: this._calibrationRunning,
      liveVisData: this._liveVisData,
      liveEQGains: this._liveEQGains,
      lastResult: this._lastMeasurementResult,
    };
  }

  isRunning() {
    return this._calibrationRunning;
  }

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

  _getCalibrationTargetDB(freq) {
    return getHarmanTargetDB(Math.max(20, Math.min(20000, freq)));
  }

  // ── Lifecycle: start() ────────────────────────────────────────────────

  start() {
    if (this._calibrationRunning) return;

    this._calibrationRunning = true;
    this._calibrationStartTime = performance.now();
    enableCalibrationLog(USE_SMART_CORRECTION ? 'smart' : 'legacy');

    this._lowInputWarningCount = 0;
    this._lastMeasurementResult = null;
    this._liveSpectrum = null;
    this._liveVisData = null;
    this._liveEQGains = null;
    this._bestResult = null;
    this._bestMaxDelta = Infinity;
    this._validMeasurementCount = 0;
    this._consecutiveSNRSkips = 0;
    this._calibrationTimeout = null;
    this._previousCandidateFreqs = null;
    this._consecutiveLowSignalCount = 0;

    this._preHealthCheck();
    this._emitStatus('Playing pink noise — listening to your room...', 'recording');

    const ctx = this._deps.audioContext;

    this._convergenceDetector = new ConvergenceDetector(
      CONVERGENCE_THRESHOLD_DB,
      CONVERGENCE_WINDOW_COUNT,
      MIN_MEASUREMENTS
    );

    this._cumulativeEQGains = new Float32Array(this._ACTIVE_EQ_FREQS.length);

    this._activeEQFilters = new Array(FILTER_POOL_SIZE)
      .fill(null)
      .map(() => {
        const filter = ctx.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = 1000;
        filter.Q.value = 1.0;
        filter.gain.value = 0;
        return filter;
      });
    for (let i = 0; i < this._activeEQFilters.length - 1; i++) {
      this._activeEQFilters[i].connect(this._activeEQFilters[i + 1]);
    }

    this._perBandMaxGain = new Float32Array(this._ACTIVE_EQ_FREQS.length).fill(INITIAL_PER_BAND_GAIN);
    this._perBandMaxCut = new Float32Array(this._ACTIVE_EQ_FREQS.length).fill(-INITIAL_PER_BAND_GAIN);
    this._perBandSaturationCount = new Uint8Array(this._ACTIVE_EQ_FREQS.length);
    this._prevBandCorrected = new Float32Array(this._ACTIVE_EQ_FREQS.length).fill(-120);

    this._pinkNoise = new PinkNoiseSource(ctx);
    this._pinkNoise.setFilterChain(this._activeEQFilters);
    this._pinkNoise.start();

    this._runPinkNoiseDiag();

    this._continuousMeasurement = this._deps.analyzer.measureContinuous(
      (result) => this._onMeasurement(result),
      MEASUREMENT_INTERVAL_MS
    );

    this._calibrationTimeout = setTimeout(() => {
      this._onTimeout();
    }, CALIBRATION_TIMEOUT_MS);
  }

  _preHealthCheck() {
    try {
      const analyzer = this._deps.analyzer;
      if (analyzer && analyzer.getRMSLevel && typeof analyzer.getRMSLevel === 'function') {
        const preRms = analyzer.getRMSLevel();
        if (preRms < SILENCE_THRESHOLD_DB) {
          this._emitStatus('Mic seems silent — check your device. Starting anyway...', 'info');
        }
      }
    } catch {
      // Safe to ignore
    }
  }

  _isDev() {
    try {
      return typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV;
    } catch {
      return false;
    }
  }

  _runPinkNoiseDiag() {
    if (!(this._isDev() || isCalibrationDebugEnabled())) return;
    setTimeout(() => {
      const analyzer = this._deps.analyzer;
      const testSpectrum = analyzer.getCurrentSpectrum();
      const linearLabels = analyzer.getLinearFrequencyLabels();
      let peakDb = -Infinity, peakFreq = 0, binsAbove90 = 0, binsAbove100 = 0;
      for (let i = 0; i < testSpectrum.length; i++) {
        if (testSpectrum[i] > peakDb) { peakDb = testSpectrum[i]; peakFreq = linearLabels[i]; }
        if (testSpectrum[i] > -90) binsAbove90++;
        if (testSpectrum[i] > -100) binsAbove100++;
      }
      const rmsNow = analyzer.getRMSLevel();
      console.log(`[cal-diag] pink noise check: peak=${peakDb.toFixed(1)}dB @${peakFreq.toFixed(0)}Hz | bins>-90dB: ${binsAbove90} | bins>-100dB: ${binsAbove100} | RMS=${rmsNow.toFixed(1)}dB`);
      if (peakDb < -100) {
        console.warn('[cal-diag] ⚠️ Pink noise NOT reaching mic — peak below -100 dBFS. Check speaker output.');
      }
    }, 1500);
  }

  _onTimeout() {
    if (!this._calibrationRunning) return;
    if (this._lastMeasurementResult) {
      this._finish(this._lastMeasurementResult, { timedOut: true });
    } else {
      this.stop();
      this._emitStatus('Calibration timed out with no usable data.', 'danger');
    }
  }

  // ── Stubs for Commits 2-3 ────────────────────────────────────────────

  _onMeasurement(result) {
    throw new Error('_onMeasurement() not yet implemented in commit 1');
  }

  _finish(result, options = {}) {
    throw new Error('_finish() not yet implemented in commit 1');
  }

  stop() {
    throw new Error('stop() not yet implemented in commit 1');
  }

  _buildPartialResult(lastResult, cumulativeGains) {
    throw new Error('_buildPartialResult() not yet implemented in commit 1');
  }

  _interpolateEQGains(freq, gains) {
    throw new Error('_interpolateEQGains() not yet implemented in commit 1');
  }

  _emitStatus(text, className) {
    this._lastStatus = { text, className };
    if (this._onStatusChange) {
      this._onStatusChange({ text, className });
    }
  }

  _emitProgress(delta) {
    if (this._onProgress) {
      this._onProgress({ text: delta, delta });
    }
  }
}
