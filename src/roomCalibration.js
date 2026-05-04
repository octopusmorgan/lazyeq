/**
 * RoomCalibration - Multi-position room measurement with spatial averaging
 * Uses continuous sine sweep for 30 seconds, capturing spectrum every 2 seconds
 */

import { SineSweepSource } from "./sineSweep.js";

const ROOM_WALK_CONFIG = {
  duration: 30000, // 30 seconds
  captureInterval: 2000, // every 2 seconds
  maxPositions: 15,
  minValidMeasurements: 10,
  outlierThreshold: 0.5, // 50% outlier bins = discard
  maxGain: 6, // dB
  maxCut: -9, // dB
  bassMax: 3 // dB
};

export class RoomCalibration {
  constructor(audioContext, analyzer) {
    this.audioContext = audioContext;
    this.analyzer = analyzer;
    this.measurements = [];
    this.isRunning = false;
    this.captureTimer = null;
    this.durationTimer = null;
    this.sweepSource = null;
    this._finalized = false;

    // Callbacks
    this.onMeasurement = null; // callback(current, total)
    this.onComplete = null; // callback(averagedSpectrum) — may return a Promise
    this.onError = null; // callback(message)

    // Config - use constants
    this.duration = ROOM_WALK_CONFIG.duration;
    this.captureInterval = ROOM_WALK_CONFIG.captureInterval;
    this.maxPositions = ROOM_WALK_CONFIG.maxPositions;
    this.minValidMeasurements = ROOM_WALK_CONFIG.minValidMeasurements;
  }

  async start() {
    if (this.isRunning) return;

    try {
      this.isRunning = true;
      this._finalized = false;
      this.measurements = [];
      let position = 0;

      // Start continuous sweep
      this.sweepSource = new SineSweepSource(this.audioContext);
      this.sweepSource.createBuffer(this.duration / 1000);
      this.sweepSource.start();

      // Start capture loop
      this.captureTimer = setInterval(() => {
        if (position >= this.maxPositions || !this.isRunning) {
          this.stop();
          return;
        }

        const spectrum = this.analyzer.getCurrentSpectrum();
        if (spectrum && this.isValidMeasurement(spectrum)) {
          this.measurements.push({
            position,
            timestamp: Date.now(),
            spectrum: Float32Array.from(spectrum)
          });
          position++;
          this.onMeasurement?.(this.measurements.length, this.maxPositions);
        }
      }, this.captureInterval);

      this.durationTimer = setTimeout(() => {
        if (this.isRunning) this.stop();
      }, this.duration);

    } catch (err) {
      this.isRunning = false;
      this.onError?.(err.message);
    }
  }

  /**
   * @param {{ cancelled?: boolean }} [opts] — cancelled: user stopped early (no onComplete/onError from averaging)
   */
  stop(opts = {}) {
    if (this._finalized) return;

    const cancelled = opts.cancelled === true;
    this.isRunning = false;

    if (this.captureTimer) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
    if (this.sweepSource) {
      this.sweepSource.stop();
      this.sweepSource = null;
    }

    if (cancelled) {
      this._finalized = true;
      return;
    }

    try {
      const avg = this.getAveragedSpectrum();
      this._finalized = true;
      try {
        const ret = this.onComplete?.(avg);
        if (ret != null && typeof ret.then === "function") {
          ret.catch((e) => this.onError?.(e.message));
        }
      } catch (e) {
        this.onError?.(e.message);
      }
    } catch (e) {
      this._finalized = true;
      this.onError?.(e.message);
    }
  }

  isValidMeasurement(spectrum) {
    let maxDB = -Infinity;
    for (let i = 0; i < spectrum.length; i++) {
      if (spectrum[i] > maxDB) maxDB = spectrum[i];
    }
    return maxDB > -80;
  }

  getMeasurements() {
    return this.measurements;
  }

  getAveragedSpectrum() {
    if (this.measurements.length < this.minValidMeasurements) {
      throw new Error(`Insufficient measurements: ${this.measurements.length} < ${this.minValidMeasurements}`);
    }

    const validMeasurements = this.filterOutliers();
    if (validMeasurements.length < this.minValidMeasurements) {
      throw new Error(`Not enough valid measurements after filtering: ${validMeasurements.length}`);
    }

    return this.calculateWeightedAverage(validMeasurements);
  }

  filterOutliers() {
    const n = this.measurements.length;
    if (n < 2) return this.measurements;

    const bins = this.measurements[0].spectrum.length;

    // Two-pass: pre-compute per-bin mean+stdDev, then score measurements.
    // Zero per-iteration allocations.
    const stats = new Float32Array(bins * 2); // [mean0, stdDev0, mean1, stdDev1, ...]

    // Pass 1: compute mean and stdDev per bin
    for (let f = 0; f < bins; f++) {
      let sum = 0;
      for (let m = 0; m < n; m++) {
        sum += this.measurements[m].spectrum[f];
      }
      const mean = sum / n;

      let varianceSum = 0;
      for (let m = 0; m < n; m++) {
        varianceSum += (this.measurements[m].spectrum[f] - mean) ** 2;
      }
      const stdDev = Math.sqrt(varianceSum / n);

      stats[f * 2] = mean;
      stats[f * 2 + 1] = stdDev;
    }

    // Pass 2: score each measurement
    const valid = [];
    for (let m = 0; m < n; m++) {
      let outlierBins = 0;

      for (let f = 0; f < bins; f++) {
        const mean = stats[f * 2];
        const stdDev = stats[f * 2 + 1];
        const diff = Math.abs(this.measurements[m].spectrum[f] - mean);

        if (diff > 2 * stdDev && stdDev > 3) outlierBins++;
      }

      if (outlierBins / bins < 0.5) {
        valid.push(this.measurements[m]);
      }
    }

    return valid;
  }

  /**
   * Secondary outlier filter using IQR (interquartile range) per bin.
   * Discards entire measurements where too many bins fall outside [Q1 - 1.5*IQR, Q3 + 1.5*IQR].
   */
  _filterOutliersIQR(measurements) {
    const n = measurements.length;
    if (n <= 3) return measurements; // need at least 4 for meaningful IQR

    const bins = measurements[0].spectrum.length;
    const valid = [];

    for (let m = 0; m < n; m++) {
      let outlierBins = 0;

      for (let f = 0; f < bins; f++) {
        const values = measurements.map(meas => meas.spectrum[f]).sort((a, b) => a - b);
        const q1 = values[Math.floor(n * 0.25)];
        const q3 = values[Math.floor(n * 0.75)];
        const iqr = q3 - q1;
        if (iqr === 0) continue; // no dispersion, can't flag outliers

        const lower = q1 - 1.5 * iqr;
        const upper = q3 + 1.5 * iqr;
        const val = measurements[m].spectrum[f];
        if (val < lower || val > upper) outlierBins++;
      }

      if (outlierBins / bins < 0.5) {
        valid.push(measurements[m]);
      }
    }

    return valid;
  }

  calculateWeightedAverage(measurements) {
    const n = measurements.length;
    const bins = measurements[0].spectrum.length;
    const result = new Float32Array(bins);

    if (n === 1) {
      for (let f = 0; f < bins; f++) result[f] = measurements[0].spectrum[f];
      return result;
    }

    // 1. Secondary IQR-based outlier filter (per-bin, discards whole measurements)
    const iqrClean = this._filterOutliersIQR(measurements);
    const clean = iqrClean.length >= this.minValidMeasurements ? iqrClean : measurements;
    const cn = clean.length;

    // 2. Convert to linear domain (power, not amplitude). Clamp dB floor to -120.
    //    -120 dB = 10^(-120/10) = 1e-12, effectively zero but safe for log10.
    const linear = clean.map(m => {
      const lin = new Float32Array(bins);
      for (let f = 0; f < bins; f++) {
        lin[f] = Math.pow(10, Math.max(m.spectrum[f], -120) / 10);
      }
      return lin;
    });

    // 3. Calculate weights based on inverse consistency (variance) in linear domain.
    //    A measurement that deviates far from the group gets lower weight.
    const weights = new Float32Array(cn);
    for (let m = 0; m < cn; m++) {
      let variance = 0;
      for (let f = 0; f < bins; f++) {
        let meanLin = 0;
        for (let i = 0; i < cn; i++) meanLin += linear[i][f];
        meanLin /= cn;
        variance += (linear[m][f] - meanLin) ** 2;
      }
      weights[m] = 1 / (1 + Math.sqrt(variance / bins));
    }

    const totalWeight = weights.reduce((a, b) => a + b, 0);

    // 4. Weighted average in linear domain, then back to dB.
    for (let f = 0; f < bins; f++) {
      let sum = 0;
      for (let m = 0; m < cn; m++) {
        sum += linear[m][f] * weights[m];
      }
      const avgLinear = sum / totalWeight;
      result[f] = 10 * Math.log10(Math.max(avgLinear, 1e-12));
    }

    return result;
  }
}

/**
 * AngularMicCompensation - Corrects for microphone angular frequency response.
 *
 * MEMS microphones in phones are omnidirectional at low frequencies but become
 * directional above ~2kHz due to the phone body and mic placement. This class
 * derives a correction curve from multi-position measurements to compensate
 * for this angular coloration before spatial averaging.
 *
 * Usage:
 *   const comp = new AngularMicCompensation({ front, left, right });
 *   const curve = comp.deriveCorrectionCurve(freqLabels);
 *   const correctedLeft = comp.applyCorrection(leftSpectrum, curve);
 */
export class AngularMicCompensation {
  /**
   * @param {Object} measurements - Spectra for each position (in dB).
   * @param {Float32Array} [measurements.front] - Reference spectrum at 0°
   * @param {Float32Array} [measurements.left] - Spectrum at -60°
   * @param {Float32Array} [measurements.right] - Spectrum at +60°
   */
  constructor(measurements = {}) {
    this.front = measurements.front || null;
    this.left = measurements.left || null;
    this.right = measurements.right || null;
    this._correctionCurve = null;
  }

  /**
   * Derive the angular correction curve from the position measurements.
   *
   * Algorithm:
   * 1. For each side position (left, right), compute: correction = front - side (dB)
   * 2. Average the corrections from available side positions
   * 3. Apply frequency mask: zero out correction for frequencies < 2000 Hz
   *    (MEMS capsule is omnidirectional in bass)
   *
   * @param {number[]} freqLabels - Array of frequency labels (one per bin), e.g. from getLinearFrequencyLabels()
   * @returns {Float32Array} Correction curve in dB, same length as input spectra
   */
  deriveCorrectionCurve(freqLabels) {
    if (!this.front) {
      // No reference — return zero curve
      return new Float32Array(this.left?.length || this.right?.length || 0);
    }

    const bins = this.front.length;
    const curve = new Float32Array(bins);

    // Count how many side positions are available
    let sideCount = 0;
    if (this.left) sideCount++;
    if (this.right) sideCount++;

    if (sideCount === 0) {
      // No side positions — nothing to correct
      return curve;
    }

    // Accumulate per-bin correction from each side position
    for (let f = 0; f < bins; f++) {
      const freq = freqLabels ? freqLabels[f] : this._binToFrequency(f);
      let sumCorrection = 0;

      if (this.left) {
        sumCorrection += this.front[f] - this.left[f];
      }
      if (this.right) {
        sumCorrection += this.front[f] - this.right[f];
      }

      // Average the corrections
      curve[f] = sumCorrection / sideCount;
    }

    // Apply frequency mask: zero out correction below 2000 Hz
    // MEMS microphones are omnidirectional at low frequencies
    const ANGULAR_MASK_FREQ = 2000; // Hz
    for (let f = 0; f < bins; f++) {
      const freq = freqLabels ? freqLabels[f] : this._binToFrequency(f);
      if (freq < ANGULAR_MASK_FREQ) {
        curve[f] = 0;
      }
    }

    this._correctionCurve = curve;
    return curve;
  }

  /**
   * Apply the angular correction curve to a spectrum.
   * The correction is ADDED to the spectrum (in dB domain).
   *
   * @param {Float32Array} spectrum - Raw dB spectrum to correct
   * @param {Float32Array} correctionCurve - Correction curve from deriveCorrectionCurve()
   * @returns {Float32Array} Corrected spectrum (new Float32Array)
   */
  applyCorrection(spectrum, correctionCurve) {
    if (!correctionCurve || correctionCurve.length !== spectrum.length) {
      return Float32Array.from(spectrum);
    }

    const corrected = new Float32Array(spectrum.length);
    for (let i = 0; i < spectrum.length; i++) {
      corrected[i] = spectrum[i] + correctionCurve[i];
    }
    return corrected;
  }

  /**
   * Convert a bin index to frequency in Hz.
   * @param {number} binIndex
   * @returns {number} Frequency in Hz
   */
  _binToFrequency(binIndex) {
    // SAMPLE_RATE = 44100, FFT_SIZE = 2048 → binWidth ≈ 21.53 Hz
    return binIndex * (44100 / 2048);
  }
}

/**
 * DirectionalCalibration - Guided 3-position room measurement with logarithmic averaging.
 * Measures at Left, Front, Right positions and combines with spatial weighting.
 */
export const DIRECTIONAL_POSITIONS = [
  { id: 'left',  label: 'Left',  icon: '←', angle: -60, weight: 1.0 },
  { id: 'front', label: 'Front', icon: '↑', angle: 0,   weight: 1.0 },
  { id: 'right', label: 'Right', icon: '→', angle: 60,  weight: 1.0 },
];

export const DIRECTIONAL_CONFIG = {
  sweepDuration: 8,      // seconds per position
  countdownSeconds: 3,   // countdown before each sweep
  gainLimits: { maxGain: 6, maxCut: -9, bassMax: 3 },
  smoothingFactor: 1.5,
};

export class DirectionalCalibration {
  constructor() {
    /** @type {Map<string, Float32Array>} position id → raw dB spectrum */
    this.results = new Map();
    this.positions = DIRECTIONAL_POSITIONS;
  }

  /**
   * Save a captured spectrum for a position.
   * @param {string} positionId - 'left' | 'front' | 'right'
   * @param {Float32Array} spectrum - Raw dB spectrum for this position
   */
  savePositionResult(positionId, spectrum) {
    this.results.set(positionId, Float32Array.from(spectrum));
  }

  /** Check whether a specific position has been captured. */
  hasPosition(positionId) {
    return this.results.has(positionId);
  }

  /** Check whether all 3 positions have been captured. */
  isComplete() {
    return this.positions.every(p => this.results.has(p.id));
  }

  /**
   * Compute the directionally-averaged spectrum with angular microphone compensation.
   *
   * Algorithm ("unified logarithm" + angular correction):
   * 1. If side positions exist, derive angular correction curve from front vs side difference
   * 2. Apply correction to side positions (only affects >= 2kHz, MEMS omnidirectional below)
   * 3. Convert each position's dB spectrum to linear power: P = 10^(dB/10)
   * 4. All positions have EQUAL weight (1.0, 1.0, 1.0) — no arbitrary spatial weighting
   * 5. Take arithmetic mean in linear domain, convert back to dB: result = 10 * log10(avg_P)
   *
   * The angular correction compensates for the microphone's directional coloration
   * at high frequencies, ensuring the spatial average reflects true room acoustics
   * rather than mic placement artifacts.
   *
   * @returns {Float32Array} Combined dB spectrum
   * @throws {Error} if not all 3 positions have been captured
   */
  getDirectionalAverage() {
    if (!this.isComplete()) {
      const missing = this.positions
        .filter(p => !this.results.has(p.id))
        .map(p => p.id);
      throw new Error(`Missing positions: ${missing.join(', ')}`);
    }

    const bins = this.results.get('front').length;

    // --- Angular microphone compensation ---
    // Derive correction curve from the difference between front and side positions.
    // This compensates for the MEMS mic's directional coloration above 2kHz.
    const angularComp = new AngularMicCompensation({
      front: this.results.get('front'),
      left: this.results.get('left'),
      right: this.results.get('right'),
    });

    // Build frequency labels for the correction curve (linear bin-to-frequency mapping)
    const binWidth = 44100 / 2048; // SAMPLE_RATE / FFT_SIZE
    const freqLabels = new Array(bins);
    for (let i = 0; i < bins; i++) {
      freqLabels[i] = i * binWidth;
    }

    const correctionCurve = angularComp.deriveCorrectionCurve(freqLabels);

    // Apply correction to side positions before averaging
    const correctedSpectra = new Map();
    correctedSpectra.set('front', this.results.get('front')); // front is the reference, no correction needed

    if (this.results.has('left')) {
      correctedSpectra.set('left', angularComp.applyCorrection(this.results.get('left'), correctionCurve));
    }
    if (this.results.has('right')) {
      correctedSpectra.set('right', angularComp.applyCorrection(this.results.get('right'), correctionCurve));
    }

    // --- Logarithmic averaging with EQUAL weights ---
    const result = new Float32Array(bins);

    // Convert each corrected position to linear power domain
    const linearSpectra = [];
    const weights = [];

    for (const pos of this.positions) {
      const spectrum = correctedSpectra.get(pos.id);
      if (!spectrum) continue;

      const linear = new Float32Array(bins);
      for (let f = 0; f < bins; f++) {
        // Clamp dB floor to -120 to avoid numerical issues
        linear[f] = Math.pow(10, Math.max(spectrum[f], -120) / 10);
      }
      linearSpectra.push(linear);
      weights.push(pos.weight); // All weights are now 1.0 (equal)
    }

    const totalWeight = weights.reduce((a, b) => a + b, 0);

    // Arithmetic mean in linear domain, then convert back to dB
    for (let f = 0; f < bins; f++) {
      let weightedSum = 0;
      for (let i = 0; i < linearSpectra.length; i++) {
        weightedSum += linearSpectra[i][f] * weights[i];
      }
      const avgLinear = weightedSum / totalWeight;
      result[f] = 10 * Math.log10(Math.max(avgLinear, 1e-12));
    }

    return result;
  }

  /** Clear all captured results. */
  reset() {
    this.results.clear();
  }
}