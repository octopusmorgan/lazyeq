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