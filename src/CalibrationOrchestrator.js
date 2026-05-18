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
  /**
   * @param {Object} deps
   * @param {SpectrumAnalyzer} deps.analyzer — MUST be initialized before start()
   * @param {AudioContext} deps.audioContext — shared context (created by main.js)
   * @param {Function} deps.processMeasurement — _processMeasurementResults from main.js
   * @param {Function} [deps.onStatusChange] — ({ text, className }) => void
   * @param {Function} [deps.onProgress] — ({ text, delta }) => void
   * @param {Function} [deps.onComplete] — (result, { timedOut, rolledBack }) => void
   */
  constructor(deps) {
    const required = ['analyzer', 'audioContext', 'processMeasurement'];
    for (const key of required) {
      if (!deps[key]) {
        throw new TypeError(`CalibrationOrchestrator: missing required dep "${key}"`);
      }
    }

    /** @private */
    this._deps = deps;

    // Optional callbacks — degrade silently when absent
    this._onStatusChange = typeof deps.onStatusChange === 'function' ? deps.onStatusChange : null;
    this._onProgress = typeof deps.onProgress === 'function' ? deps.onProgress : null;
    this._onComplete = typeof deps.onComplete === 'function' ? deps.onComplete : null;

    // Shared constants
    this._ACTIVE_EQ_FREQS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

    // Initialize all state
    this._resetState();
  }

  // ── State Management ──────────────────────────────────────────────────

  /** Reset all calibration state to defaults. @private */
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
      liveSpectrum: this._liveSpectrum,
      cumulativeGains: this._cumulativeEQGains,
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

  // ── Calibration Target ────────────────────────────────────────────────

  /**
   * Calibration target in dB at frequency `freq`.
   * @param {number} freq
   * @returns {number}
   * @private
   */
  _getCalibrationTargetDB(freq) {
    return getHarmanTargetDB(Math.max(20, Math.min(20000, freq)));
  }

  // ── Lifecycle: start() ────────────────────────────────────────────────

  /**
   * Begin calibration lifecycle.
   * Sets up pink noise, filter chain, measurement loop, and watchdog.
   * Idempotent if already running.
   *
   * The caller (main.js) should:
   *   - Call getUserMedia()+analyzer.init(stream,ctx) BEFORE start()
   *   - Call computeTargetCurveCache() BEFORE start()
   *   - Start animationFrame AFTER start() resolves
   *   - Handle UI toggles (button visibility)
   */
  start() {
    if (this._calibrationRunning) return;

    this._calibrationRunning = true;
    this._calibrationStartTime = performance.now();
    enableCalibrationLog(USE_SMART_CORRECTION ? 'smart' : 'legacy');

    // Reset state for new calibration
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

    // Pre-calibration health check
    this._preHealthCheck();

    // Report initial status
    this._emitStatus('Playing pink noise — listening to your room...', 'recording');

    const ctx = this._deps.audioContext;

    // Reset convergence detector
    this._convergenceDetector = new ConvergenceDetector(
      CONVERGENCE_THRESHOLD_DB,
      CONVERGENCE_WINDOW_COUNT,
      MIN_MEASUREMENTS
    );

    // Initialize cumulative EQ (starts flat)
    this._cumulativeEQGains = new Float32Array(this._ACTIVE_EQ_FREQS.length);

    // Create 16-filter pool, chained in series
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

    // Initialize adaptive per-band gain limits
    this._perBandMaxGain = new Float32Array(this._ACTIVE_EQ_FREQS.length).fill(INITIAL_PER_BAND_GAIN);
    this._perBandMaxCut = new Float32Array(this._ACTIVE_EQ_FREQS.length).fill(-INITIAL_PER_BAND_GAIN);
    this._perBandSaturationCount = new Uint8Array(this._ACTIVE_EQ_FREQS.length);
    this._prevBandCorrected = new Float32Array(this._ACTIVE_EQ_FREQS.length).fill(-120);

    // Start pink noise with active EQ filter chain
    this._pinkNoise = new PinkNoiseSource(ctx);
    this._pinkNoise.setFilterChain(this._activeEQFilters);
    this._pinkNoise.start();

    // Diagnostic pink noise check (debug only)
    this._runPinkNoiseDiag();

    // Start continuous measurement
    this._continuousMeasurement = this._deps.analyzer.measureContinuous(
      (result) => this._onMeasurement(result),
      MEASUREMENT_INTERVAL_MS
    );

    // Set 30s watchdog timeout
    this._calibrationTimeout = setTimeout(() => {
      this._onTimeout();
    }, CALIBRATION_TIMEOUT_MS);
  }

  /** @private */
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
      // Safe to ignore — calibration will proceed
    }
  }

  /** @private */
  _isDev() {
    try {
      return typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV;
    } catch {
      return false;
    }
  }

  /** @private */
  _runPinkNoiseDiag() {
    if (!(this._isDev() || isCalibrationDebugEnabled())) return;
    setTimeout(() => {
      const analyzer = this._deps.analyzer;
      const testSpectrum = analyzer.getCurrentSpectrum();
      const linearLabels = analyzer.getLinearFrequencyLabels();
      let peakDb = -Infinity;
      let peakFreq = 0;
      let binsAbove90 = 0;
      let binsAbove100 = 0;
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

  /** @private */
  _onTimeout() {
    if (!this._calibrationRunning) return;
    if (this._lastMeasurementResult) {
      this._finish(this._lastMeasurementResult, { timedOut: true });
    } else {
      this.stop();
      this._emitStatus('Calibration timed out with no usable data.', 'danger');
    }
  }

  // ── Lifecycle: _onMeasurement() ───────────────────────────────────────

  /**
   * Core measurement callback — called every ~500ms by measureContinuous.
   * @param {{ spectrum: Float32Array, rms: number, elapsedMs: number }} result
   * @private
   */
  _onMeasurement({ spectrum, rms, elapsedMs }) {
    // Guard: analyzer may be null after calibration completes (race condition)
    if (!this._deps.analyzer) return;

    const analyzer = this._deps.analyzer;
    const noiseFloorRms = analyzer.getNoiseFloorRMS();
    const linearLabels = analyzer.getLinearFrequencyLabels();

    // Timeout check
    if (elapsedMs > CALIBRATION_TIMEOUT_MS) {
      if (this._lastMeasurementResult) {
        this._finish(this._lastMeasurementResult, { timedOut: true });
      } else {
        this.stop();
        this._emitStatus('Calibration timed out with no usable data.', 'danger');
      }
      return;
    }

    // SNR gating
    if (noiseFloorRms > -100) {
      const snr = rms - noiseFloorRms;
      if (snr < SNR_THRESHOLD_DB) {
        this._consecutiveSNRSkips++;
        if (this._consecutiveSNRSkips >= 20) {
          this._emitStatus('Low signal-to-noise ratio — check speaker volume or move closer.', 'danger');
        }
        return;
      }
    }

    // Valid measurement
    this._consecutiveSNRSkips = 0;
    this._validMeasurementCount++;

    // Low-input warning
    if (rms < -60) {
      this._lowInputWarningCount++;
      if (this._lowInputWarningCount >= 3) {
        this._emitStatus('Room seems quiet — try moving closer to the speaker or increasing your speaker volume.', 'danger');
      }
    } else {
      this._lowInputWarningCount = 0;
      // Revert status if it was in danger state
      const prev = this._lastStatus;
      if (prev && prev.className === 'danger') {
        this._emitStatus('Playing pink noise — listening to your room...', 'recording');
      }
    }

    // Process through the existing pipeline
    const corrected = analyzer.getCorrectedSpectrumFromDB(spectrum);
    if (!corrected) return;

    // Sanitize: replace -Infinity/NaN
    for (let i = 0; i < corrected.length; i++) {
      if (!isFinite(corrected[i])) corrected[i] = -120;
    }

    // Branch: Smart Correction vs Legacy 8-band path
    if (USE_SMART_CORRECTION) {
      this._handleSmartCorrection({ spectrum, rms, elapsedMs, corrected, noiseFloorRms, linearLabels });
    } else {
      this._handleLegacyCorrection({ spectrum, rms, elapsedMs, corrected, noiseFloorRms, linearLabels });
    }
  }

  /**
   * Smart Correction path: detect → rank → synthesize → filter pool.
   * @param {Object} ctx
   * @private
   */
  _handleSmartCorrection({ spectrum, rms, elapsedMs, corrected, noiseFloorRms, linearLabels }) {
    try {
      const processResult = this._deps.processMeasurement(corrected, {
        method: 'pink-noise',
        gainLimits: { maxGain: 4, maxCut: -4, bassMax: 4 },
        perBandMaxGain: this._perBandMaxGain,
        perBandMaxCut: this._perBandMaxCut,
        smoothingFactor: 2.5,
        effectiveRange: { low: 100, high: 8000 },
      });

      // Signal level guard
      const hasUsableSignal = processResult.visData.some((v, i) => {
        const freq = v.x;
        const val = processResult.normalizedResponse[i];
        return freq >= 100 && freq <= 8000 && Number.isFinite(val) && val > -30;
      });

      if (!hasUsableSignal) {
        this._handleLowSignal({ spectrum, rms, elapsedMs, corrected, noiseFloorRms, linearLabels, processResult });
      } else {
        this._handleGoodSignal({ spectrum, rms, elapsedMs, corrected, noiseFloorRms, linearLabels, processResult });
      }
    } catch (err) {
      console.error('[SmartCorrection] Error in measurement window — skipping:', err);
      logCalibrationError(err);
    }
  }

  /** @private */
  _handleLowSignal({ spectrum, rms, elapsedMs, corrected, noiseFloorRms, linearLabels, processResult }) {
    this._consecutiveLowSignalCount++;
    if (this._consecutiveLowSignalCount >= LOW_SIGNAL_WINDOW_COUNT) {
      this._emitStatus("Mic isn't receiving the speaker signal — try moving closer or check audio output device.", 'danger');
    }

    this._liveSpectrum = spectrum;
    this._liveVisData = processResult.visData.map((d, i) => ({
      x: d.x,
      y: processResult.normalizedResponse[i],
    }));
    this._liveEQGains = new Float32Array(this._ACTIVE_EQ_FREQS.length);
    this._lastMeasurementResult = {
      visData: processResult.visData,
      normalizedResponse: processResult.normalizedResponse,
      gains: processResult.gains,          // 64-element: used by showResults (EQ table/curve)
      rangeAvg: processResult.rangeAvg,
      eqBandGains: this._liveEQGains,       // 8-element: active EQ band corrections
    };
    this._emitProgress('Δ — dB');

    // Keep convergence detector alive
    if (this._convergenceDetector) {
      this._convergenceDetector.push(new Float32Array(EVAL_FREQUENCIES.length));
    }

    logCalibrationWindow({
      mode: 'smart',
      elapsedMs,
      rms,
      noiseFloorRms,
      rangeAvg: processResult.rangeAvg,
      linearLabels,
      rawSpectrum: spectrum,
      correctedSpectrum: corrected,
      normalizedResponse: processResult.normalizedResponse,
      visFreqs: processResult.visData.map(v => v.x),
      targetCurve: new Float32Array(0),
      bands: [],
    });
  }

  /** @private */
  _handleGoodSignal({ spectrum, rms, elapsedMs, corrected, noiseFloorRms, linearLabels, processResult }) {
    this._consecutiveLowSignalCount = 0;

    // Build target curve at visData frequencies
    const targetCurve = new Float32Array(processResult.visData.length);
    const freqs = processResult.visData.map(v => v.x);
    for (let i = 0; i < targetCurve.length; i++) {
      targetCurve[i] = this._getCalibrationTargetDB(freqs[i]);
    }

    const smartResult = runSmartCorrectionPipeline(
      processResult.normalizedResponse,
      targetCurve,
      freqs,
      this._previousCandidateFreqs
    );

    this._previousCandidateFreqs = smartResult.candidates.map(c => c.freq);
    this.updateFilterPool(smartResult.bands);
    this._currentParametricBands = smartResult.bands;
    this._cumulativeEQGains = smartResult.gains;

    this._liveSpectrum = spectrum;
    this._liveVisData = processResult.visData.map((d, i) => ({
      x: d.x,
      y: processResult.normalizedResponse[i],
    }));
    this._liveEQGains = smartResult.gains;
    this._lastMeasurementResult = {
      visData: processResult.visData,
      normalizedResponse: processResult.normalizedResponse,
      gains: processResult.gains,       // 64-element: used by showResults (EQ table/curve)
      rangeAvg: processResult.rangeAvg,
      eqBandGains: smartResult.gains,    // 8-element: active EQ band corrections
    };

    // Track best result
    const currentMax = smartResult.maxResidual;
    if (!this._bestResult || currentMax < this._bestMaxDelta) {
      this._bestResult = this._lastMeasurementResult;
      this._bestMaxDelta = currentMax;
    }

    // Feed convergence detector
    let isStable = false;
    if (this._convergenceDetector) {
      const convergenceResult = this._convergenceDetector.push(smartResult.evalResiduals);
      const correctableMax = smartResult.maxResidual;

      isStable = convergenceResult.converged
        && this._validMeasurementCount >= MIN_MEASUREMENTS
        && correctableMax <= SMART_RESIDUAL_THRESHOLD_DB
        && this._consecutiveLowSignalCount < LOW_SIGNAL_WINDOW_COUNT;

      if (this._isDev()) {
        const p = smartResult.pipelineStats || {};
        console.log(
          `  Δres = ${convergenceResult.delta.toFixed(2)} dB | ` +
          `raw_max|res| = ${smartResult.rawMaxResidual.toFixed(1)} dB | ` +
          `corr_max = ${correctableMax.toFixed(1)} dB | ` +
          `bands=${smartResult.bands.length} cand=${smartResult.candidates.length} ` +
          `pass=${smartResult.passName ?? 'n/a'} ` +
          `raw=${p.rawCandidates ?? 0}->width=${p.afterWidthReject ?? 0}->` +
          `merge=${p.afterMerge ?? 0}->rank=${p.ranked ?? 0}->` +
          `bands=${p.bands ?? smartResult.bands.length} ` +
          `${isStable ? '✅ CONVERGED' : ''}`
        );
      }

      this._emitProgress('Δres ' + convergenceResult.delta.toFixed(1) + ' dB');

      if (isStable) {
        logCalibrationConverged(elapsedMs);
        this._finish(this._lastMeasurementResult);
      }
    }

    logCalibrationWindow({
      mode: 'smart',
      elapsedMs,
      rms,
      noiseFloorRms,
      rangeAvg: processResult.rangeAvg,
      linearLabels,
      rawSpectrum: spectrum,
      correctedSpectrum: corrected,
      normalizedResponse: processResult.normalizedResponse,
      visFreqs: processResult.visData.map(v => v.x),
      targetCurve,
      bands: smartResult.bands,
    });
  }

  /**
   * Legacy 8-band correction path.
   * @param {Object} ctx
   * @private
   */
  _handleLegacyCorrection({ spectrum, rms, elapsedMs, corrected, noiseFloorRms, linearLabels }) {
    const result = this._deps.processMeasurement(corrected, {
      method: 'pink-noise',
      gainLimits: { maxGain: 4, maxCut: -4, bassMax: 4 },
      perBandMaxGain: this._perBandMaxGain,
      perBandMaxCut: this._perBandMaxCut,
      smoothingFactor: 2.5,
      effectiveRange: { low: 100, high: 8000 },
    });

    const legacyVisFreqs = result.visData.map(v => v.x);
    const legacyTarget = new Float32Array(legacyVisFreqs.length);
    for (let i = 0; i < legacyTarget.length; i++) {
      legacyTarget[i] = this._getCalibrationTargetDB(legacyVisFreqs[i]);
    }

    logCalibrationWindow({
      mode: 'legacy',
      elapsedMs,
      rms,
      noiseFloorRms,
      rangeAvg: result.rangeAvg,
      linearLabels,
      rawSpectrum: spectrum,
      correctedSpectrum: corrected,
      normalizedResponse: result.normalizedResponse,
      visFreqs: legacyVisFreqs,
      targetCurve: legacyTarget,
      pointwiseEqGains: Float32Array.from(result.gains),
    });

    // Interpolate gains to filter bands
    const deltaGains = new Float32Array(this._ACTIVE_EQ_FREQS.length);
    for (let f = 0; f < this._ACTIVE_EQ_FREQS.length; f++) {
      const targetFreq = this._ACTIVE_EQ_FREQS[f];
      let gain = 0;
      const point = result.visData.find(v => Math.abs(v.x - targetFreq) < targetFreq * 0.15);
      if (point) {
        const idx = result.visData.indexOf(point);
        gain = result.gains[idx];
      }
      deltaGains[f] = gain;
    }

    // Adaptive per-band saturation detection
    this._applySaturationDetection(corrected, deltaGains);

    // Apply cumulative EQ with per-band limits
    for (let f = 0; f < this._ACTIVE_EQ_FREQS.length; f++) {
      this._cumulativeEQGains[f] += deltaGains[f];
      const bandMax = this._perBandMaxGain ? this._perBandMaxGain[f] : 4;
      const bandMin = this._perBandMaxCut ? this._perBandMaxCut[f] : -4;
      this._cumulativeEQGains[f] = Math.max(bandMin, Math.min(bandMax, this._cumulativeEQGains[f]));
      if (this._activeEQFilters && this._activeEQFilters[f]) {
        this._activeEQFilters[f].gain.value = this._cumulativeEQGains[f];
      }
    }

    // Diagnostic logs
    if (import.meta.env.DEV) {
      this._logLegacyDiagnostics({ elapsedMs, rms, spectrum, corrected, deltaGains });
    }

    // Track best result
    const currentMax = Math.max(...Array.from(deltaGains).map(Math.abs));
    if (!this._bestResult || currentMax < this._bestMaxDelta) {
      this._bestResult = result;
      this._bestMaxDelta = currentMax;
    }

    // Update state for canvas rendering
    this._liveSpectrum = spectrum;
    this._liveEQGains = result.gains;
    this._lastMeasurementResult = result;

    // Feed convergence detector
    if (this._convergenceDetector) {
      const { converged, delta } = this._convergenceDetector.push(deltaGains);
      const maxCorrection = Math.max(...Array.from(deltaGains).map(Math.abs));
      const isStable = converged && maxCorrection < 1.0;

      if (this._isDev()) {
        console.log(`  Δ = ${delta.toFixed(2)} dB | max|corr| = ${maxCorrection.toFixed(1)} dB ${isStable ? '✅ CONVERGED' : ''}`);
      }

      this._emitProgress('Δ ' + delta.toFixed(1) + ' dB');

      if (isStable) {
        this._finish(result);
      }
    }
  }

  /** @private */
  _applySaturationDetection(corrected, deltaGains) {
    if (!this._perBandSaturationCount || !this._prevBandCorrected) return;
    const analyzer = this._deps.analyzer;
    const binWidth = analyzer.audioContext.sampleRate / analyzer.analyserNode.fftSize;
    for (let f = 0; f < this._ACTIVE_EQ_FREQS.length; f++) {
      const bin = Math.round(this._ACTIVE_EQ_FREQS[f] / binWidth);
      const currResp = corrected[bin];
      const expected = deltaGains[f];
      const actual = isFinite(this._prevBandCorrected[f]) && isFinite(currResp)
        ? currResp - this._prevBandCorrected[f]
        : 0;

      if (Math.abs(expected) > 1.0 && Math.abs(actual) < Math.abs(expected) * SATURATION_RATIO_THRESHOLD) {
        this._perBandSaturationCount[f]++;
        if (this._perBandSaturationCount[f] >= SATURATION_CONSECUTIVE_COUNT) {
          if (expected > 0) {
            this._perBandMaxGain[f] = Math.max(1.0, this._perBandMaxGain[f] * 0.75);
          } else {
            this._perBandMaxCut[f] = Math.min(-1.0, this._perBandMaxCut[f] * 0.75);
          }
          this._perBandSaturationCount[f] = 0;
        }
      } else {
        this._perBandSaturationCount[f] = 0;
      }
      this._prevBandCorrected[f] = currResp;
    }
  }

  /** @private */
  _logLegacyDiagnostics({ elapsedMs, rms, spectrum, corrected, deltaGains }) {
    const keyFreqs = this._ACTIVE_EQ_FREQS;
    const elapsed = (elapsedMs / 1000).toFixed(1);
    const binWidth = this._deps.analyzer.audioContext.sampleRate / this._deps.analyzer.analyserNode.fftSize;

    const rawVals = keyFreqs.map(f => {
      const bin = Math.round(f / binWidth);
      return spectrum[bin]?.toFixed(1) ?? '---';
    }).join(' | ');

    const corVals = keyFreqs.map(f => {
      const bin = Math.round(f / binWidth);
      return corrected[bin]?.toFixed(1) ?? '---';
    }).join(' | ');

    const dVals = keyFreqs.map((_, i) => {
      const g = deltaGains[i];
      return (g >= 0 ? '+' : '') + g.toFixed(1);
    }).join(' | ');

    const cVals = keyFreqs.map((_, i) => {
      const g = this._cumulativeEQGains[i];
      return (g >= 0 ? '+' : '') + g.toFixed(1);
    }).join(' | ');

    console.log(
      `[t=${elapsed}s] RMS=${rms.toFixed(0)}dB\n` +
      `  Freq (Hz):   ${keyFreqs.map(f => String(f).padStart(5)).join(' | ')}\n` +
      `  Raw:         ${rawVals}\n` +
      `  Corrected:   ${corVals}\n` +
      `  Δ needed:    ${dVals}\n` +
      `  Cumulative:  ${cVals}`
    );
  }

  // ── Lifecycle: _finish() ──────────────────────────────────────────────

  /**
   * Called when convergence is detected or timeout fires.
   * @param {Object} result
   * @param {{ timedOut?: boolean }} [options]
   * @private
   */
  _finish(result, options = {}) {
    // Clear the watchdog timeout
    if (this._calibrationTimeout) {
      clearTimeout(this._calibrationTimeout);
      this._calibrationTimeout = null;
    }

    // Stop pink noise and measurement
    if (this._pinkNoise) {
      this._pinkNoise.stop();
      this._pinkNoise = null;
    }
    if (this._continuousMeasurement) {
      this._continuousMeasurement.stop();
      this._continuousMeasurement = null;
    }

    this._calibrationRunning = false;

    // Save profile
    const saveResult = saveProfile({
      gains: float32ToArray(this._cumulativeEQGains),
      timestamp: Date.now(),
      type: 'pink-noise',
      bands: this._currentParametricBands,
    });

    // Notify caller with result
    if (this._onComplete) {
      this._onComplete(result, {
        timedOut: options.timedOut,
        rolledBack: saveResult.rolledBack,
      });
    }

    // Final status message
    if (options.timedOut) {
      this._emitStatus('Calibration timed out — showing best available result. Try moving closer to the speaker.', 'info');
    } else {
      this._emitStatus('Calibration complete! Your EQ is ready.', 'done');
    }
  }

  // ── Lifecycle: stop() ─────────────────────────────────────────────────

  /**
   * Manual stop (user click, error, visibility). Idempotent.
   */
  stop() {
    // Clear the watchdog timeout
    if (this._calibrationTimeout) {
      clearTimeout(this._calibrationTimeout);
      this._calibrationTimeout = null;
    }

    // Release analyzer
    const analyzer = this._deps.analyzer;
    if (analyzer && analyzer.destroy) {
      analyzer.destroy();
    }

    // Guard: if nothing is running, just reset and return
    if (!this._calibrationRunning && !this._pinkNoise && !this._continuousMeasurement) {
      this._resetState();
      this._emitStatus('Calibration stopped.', '');
      return;
    }

    // Stop audio resources
    if (this._pinkNoise) {
      this._pinkNoise.stop();
      this._pinkNoise = null;
    }
    if (this._continuousMeasurement) {
      this._continuousMeasurement.stop();
      this._continuousMeasurement = null;
    }

    // Save cumulative EQ before cleaning up state
    const savedCumulativeGains = this._cumulativeEQGains
      ? new Float32Array(this._cumulativeEQGains)
      : null;

    const hadPartialData = this._lastMeasurementResult
      && this._convergenceDetector
      && this._convergenceDetector.windowCount >= 2;

    // Build partial result if we have enough data
    if (hadPartialData) {
      const partialResult = this._buildPartialResult(this._lastMeasurementResult, savedCumulativeGains);

      saveProfile({
        gains: partialResult.gains,
        timestamp: Date.now(),
        type: 'pink-noise',
        bands: this._currentParametricBands,
      });

      if (this._onComplete) {
        this._onComplete(partialResult, { timedOut: false, rolledBack: false });
      }

      this._emitStatus('Calibration stopped early. Showing EQ from partial measurement.', 'info');
    } else {
      this._emitStatus('Calibration stopped.', '');
    }

    // Reset all state
    this._resetState();
  }

  // ── Partial Result Helpers ────────────────────────────────────────────

  /**
   * Build a partial result from the last measurement and cumulative EQ gains.
   * Interpolates the 8 filter-band cumulative gains to the visData points.
   * @param {Object} lastResult
   * @param {Float32Array|null} cumulativeGains
   * @returns {Object} result compatible with showResults()
   * @private
   */
  _buildPartialResult(lastResult, cumulativeGains) {
    if (!cumulativeGains) return lastResult;

    const { visData, normalizedResponse } = lastResult;
    const gains = [];

    for (let i = 0; i < visData.length; i++) {
      const freq = visData[i].x;
      gains.push(this._interpolateEQGains(freq, cumulativeGains));
    }

    return { visData, normalizedResponse, gains, rangeAvg: lastResult.rangeAvg };
  }

  /**
   * Interpolate cumulative EQ gain at a given frequency from the 8 filter bands.
   * Uses log-frequency linear interpolation. Extrapolates flat beyond the band edges.
   * @param {number} freq — target frequency in Hz
   * @param {Float32Array} gains — 8-band cumulative gains
   * @returns {number} interpolated gain in dB
   * @private
   */
  _interpolateEQGains(freq, gains) {
    const freqs = this._ACTIVE_EQ_FREQS;
    if (freq <= freqs[0]) return gains[0];
    if (freq >= freqs[freqs.length - 1]) return gains[gains.length - 1];

    for (let i = 0; i < freqs.length - 1; i++) {
      if (freq >= freqs[i] && freq <= freqs[i + 1]) {
        const ratio = (Math.log10(freq) - Math.log10(freqs[i])) /
                      (Math.log10(freqs[i + 1]) - Math.log10(freqs[i]));
        return gains[i] + ratio * (gains[i + 1] - gains[i]);
      }
    }
    return 0;
  }

  // ── Internal Helpers ─────────────────────────────────────────────────

  /** @private */
  _emitStatus(text, className) {
    this._lastStatus = { text, className };
    if (this._onStatusChange) {
      this._onStatusChange({ text, className });
    }
  }

  /** @private */
  _emitProgress(delta) {
    if (this._onProgress) {
      this._onProgress({ text: delta, delta });
    }
  }
}
