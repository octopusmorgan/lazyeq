/**
 * LegacySweepOrchestrator — legacy sine sweep measurement lifecycle manager.
 *
 * Encapsulates the legacy sine sweep loop (~200 lines from main.js) into
 * a DI-friendly class following the CalibrationOrchestrator pattern.
 * Zero behavioral changes.
 *
 * Communicates outward exclusively via constructor-injected callbacks — no DOM access.
 */

import { SineSweepSource } from './sineSweep.js';

export class LegacySweepOrchestrator {
  /**
   * @param {Object} deps
   * @param {SpectrumAnalyzer} deps.analyzer — MUST be initialized before run()
   * @param {AudioContext} deps.audioContext — shared context (created by main.js)
   * @param {Function} deps.processMeasurement — _processMeasurementResults from main.js
   * @param {Function} [deps.onStatusChange] — ({ text, className }) => void
   * @param {Function} [deps.onProgress] — ({ text }) => void
   * @param {Function} [deps.onComplete] — (result, options) => void
   * @param {Function} [deps.renderFrame] — (spectrum: Float32Array) => void
   */
  constructor(deps) {
    const required = ['analyzer', 'audioContext', 'processMeasurement'];
    for (const key of required) {
      if (!deps[key]) {
        throw new TypeError(`LegacySweepOrchestrator: missing required dep "${key}"`);
      }
    }

    /** @private */
    this._deps = deps;

    // Optional callbacks — degrade silently when absent
    this._onStatusChange = typeof deps.onStatusChange === 'function' ? deps.onStatusChange : null;
    this._onProgress = typeof deps.onProgress === 'function' ? deps.onProgress : null;
    this._onComplete = typeof deps.onComplete === 'function' ? deps.onComplete : null;
    this._renderFrame = typeof deps.renderFrame === 'function' ? deps.renderFrame : null;

    this._resetState();
  }

  // ── State Management ──────────────────────────────────────────────────

  /** Reset all sweep state to defaults. @private */
  _resetState() {
    this._running = false;
    this._currentSweep = 0;
    this._totalSweeps = 0;
    this._accumulatedSpectrum = null;
    this._frameCount = 0;
    this._legacyAnimationFrame = null;
    this._sweepSource = null;
    this._allSpectra = [];
    this._stopped = false;
  }

  // ── Accessors ─────────────────────────────────────────────────────────

  /**
   * @returns {{ running: boolean, currentSweep: number, totalSweeps: number }}
   */
  getState() {
    return {
      running: this._running,
      currentSweep: this._currentSweep,
      totalSweeps: this._totalSweeps,
    };
  }

  /** @returns {boolean} */
  isRunning() {
    return this._running;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Run N consecutive sine sweeps, accumulate frequency-domain results,
   * compute bin-wise average, and invoke completion callbacks.
   * @param {number} sweepCount - Number of sweeps to run (default 2)
   * @returns {Promise<void>}
   */
  async run(sweepCount = 2) {
    if (this._running) {
      throw new Error('LegacySweepOrchestrator: sweep already in progress');
    }

    this._resetState();
    this._running = true;
    this._totalSweeps = sweepCount;
    this._stopped = false;

    const { analyzer, audioContext, processMeasurement } = this._deps;

    for (let sweepNum = 0; sweepNum < sweepCount; sweepNum++) {
      if (this._stopped) break;

      this._currentSweep = sweepNum + 1;

      // Reset per-sweep accumulation
      this._accumulatedSpectrum = null;
      this._frameCount = 0;

      if (this._onStatusChange) {
        this._onStatusChange({
          text: `Sweep ${sweepNum + 1} of ${sweepCount}...`,
          className: 'status recording',
        });
      }

      // Fresh SineSweepSource per sweep (matches main.js line 1116)
      const legacySweep = new SineSweepSource(audioContext);
      legacySweep.createBuffer(8);

      // Wait for this sweep to complete
      await new Promise((resolve) => {
        this._sweepSource = legacySweep;

        legacySweep.onComplete = () => {
          if (this._stopped) {
            resolve();
            return;
          }

          // Apply 1/f compensation to the accumulated peak-hold spectrum
          const f0 = 20;
          const sr = analyzer.audioContext.sampleRate;
          const fftSz = analyzer.analyserNode.fftSize;
          const bw = sr / fftSz;

          const accumulated = this._accumulatedSpectrum || new Float32Array(0);
          const compensated = new Float32Array(accumulated.length);
          const n = Math.max(this._frameCount, 1);
          for (let i = 0; i < accumulated.length; i++) {
            const avgDb = accumulated[i] / n;
            const freq = i * bw;
            compensated[i] = freq > f0
              ? avgDb + 10 * Math.log10(freq / f0)
              : avgDb;
          }

          this._allSpectra.push(compensated);
          this._accumulatedSpectrum = null;
          this._frameCount = 0;
          this._sweepSource = null;

          // Cancel animation frame for rendering
          this._cancelAnimationFrame();

          resolve();
        };

        legacySweep.start();

        // Start rAF loop for live canvas rendering
        this._animationLoop();
      });

      // Brief pause between sweeps (matches main.js line 1155)
      if (this._stopped) break;
      if (sweepNum < sweepCount - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Check if stopped mid-way
    if (this._stopped || this._allSpectra.length === 0) {
      this._running = false;
      if (this._onComplete) {
        this._onComplete(null, { stopped: true });
      }
      return;
    }

    // All sweeps done — average the compensated spectra
    if (this._onStatusChange) {
      this._onStatusChange({
        text: `Averaging ${this._allSpectra.length} sweeps...`,
        className: 'status info',
      });
    }

    const averaged = new Float32Array(this._allSpectra[0].length);
    for (let i = 0; i < averaged.length; i++) {
      let sum = 0;
      for (const spectrum of this._allSpectra) {
        sum += spectrum[i];
      }
      averaged[i] = sum / this._allSpectra.length;
    }

    // Process results using the shared pipeline
    const corrected = analyzer.getCorrectedSpectrumFromDB(averaged);
    const result = processMeasurement(corrected, {
      method: 'sweep',
      gainLimits: { maxGain: 4, maxCut: -4, bassMax: 4 },
      smoothingFactor: 2.5,
      effectiveRange: { low: 100, high: 8000 },
    });

    this._running = false;

    if (this._onStatusChange) {
      this._onStatusChange({
        text: 'Legacy sweep complete! EQ curve ready to export.',
        className: 'status done',
      });
    }

    if (this._onComplete) {
      this._onComplete(result, { spectrum: averaged, stopped: false });
    }
  }

  /**
   * Terminate in-progress sweep, release audio resources.
   * Safe to call when no sweep is running (no-op).
   */
  stop() {
    if (!this._running && this._allSpectra.length === 0) {
      return; // no-op
    }

    this._stopped = true;
    this._cancelAnimationFrame();

    if (this._sweepSource) {
      try {
        this._sweepSource.stop();
      } catch (_) {
        // Ignore errors from stopping — sweep may already be complete
      }
      this._sweepSource = null;
    }

    this._running = false;
  }

  // ── Private: Animation Loop ───────────────────────────────────────────

  /** @private */
  _animationLoop() {
    if (this._stopped || !this._running) return;

    const { analyzer } = this._deps;
    const data = analyzer.getCurrentSpectrum();
    if (data) {
      // Accumulate spectrum data for post-sweep processing
      if (!this._accumulatedSpectrum) {
        this._accumulatedSpectrum = new Float32Array(data.length);
      }
      for (let i = 0; i < data.length; i++) {
        this._accumulatedSpectrum[i] += data[i];
      }
      this._frameCount++;

      // Invoke renderFrame callback for live canvas display
      if (this._renderFrame) {
        this._renderFrame(data);
      }
    }

    // Continue rendering while sweep is active
    if (this._sweepSource) {
      this._legacyAnimationFrame = requestAnimationFrame(() => this._animationLoop());
    }
  }

  /** @private */
  _cancelAnimationFrame() {
    if (this._legacyAnimationFrame) {
      cancelAnimationFrame(this._legacyAnimationFrame);
      this._legacyAnimationFrame = null;
    }
  }
}
