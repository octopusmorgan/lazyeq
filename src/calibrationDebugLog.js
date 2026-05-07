/**
 * Simple calibration logger for lazyEq.
 *
 * Collects one-line snapshots per measurement window, tracks errors,
 * and produces a plain-text dump easy to copy/paste for review.
 *
 * Enable with any of:
 *   - `CALIBRATION_DEBUG = true` in constants.js (rebuild)
 *   - `localStorage.setItem('lazyeq.calibrationDebug', '1')` + reload
 *   - `window.__LAZYEQ_CALIBRATION_DEBUG__ = true` before calibrating
 *
 * Usage in console after calibration:
 *   window.__CAL_LOG__.dump()   → prints full log as plain text
 *   window.__CAL_LOG__.summary() → one-line health summary
 *   window.__CAL_LOG__.clear()  → reset
 */

import {
  CALIBRATION_DEBUG,
  CALIBRATION_DEBUG_KEY_FREQS,
} from './constants.js';
import { evaluateCurveAt } from './parametricEqSynthesizer.js';

// ─── State ────────────────────────────────────────────────────────────

let _enabled = false;
let _windows = [];
let _errors = [];
let _startTime = 0;
let _mode = '';
let _convergedAt = null;

// ─── Enable check ─────────────────────────────────────────────────────

export function isCalibrationDebugEnabled() {
  if (CALIBRATION_DEBUG) return true;
  if (typeof globalThis !== 'undefined' && globalThis.__LAZYEQ_CALIBRATION_DEBUG__ === true) return true;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('lazyeq.calibrationDebug') === '1') return true;
  } catch { /* private mode */ }
  return false;
}

// ─── Interpolation helpers ────────────────────────────────────────────

export function sampleDbAtLinearFreq(spectrum, linearLabels, freqHz) {
  if (!spectrum?.length || !linearLabels?.length) return NaN;
  let lo = 0, hi = linearLabels.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (linearLabels[mid] <= freqHz) lo = mid; else hi = mid;
  }
  const binIdx = Math.abs(freqHz - linearLabels[lo]) <= Math.abs(linearLabels[hi] - freqHz) ? lo : hi;
  return spectrum[binIdx] ?? NaN;
}

export function interpLogFreq(xs, ys, xq) {
  if (!xs.length) return NaN;
  if (xq <= xs[0]) return ys[0];
  if (xq >= xs[xs.length - 1]) return ys[xs.length - 1];
  const logQ = Math.log10(xq);
  let lo = 0, hi = xs.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (Math.log10(xs[mid]) <= logQ) lo = mid; else hi = mid;
  }
  const t = (logQ - Math.log10(xs[lo])) / (Math.log10(xs[hi]) - Math.log10(xs[lo]));
  return ys[lo] * (1 - t) + ys[hi] * t;
}

// ─── Snapshot: one per window ─────────────────────────────────────────

/**
 * Record a calibration window snapshot.
 * @param {Object} p — same params as the old logCalibrationWindow
 */
export function logCalibrationWindow(p) {
  if (!_enabled) return;

  const freqs = CALIBRATION_DEBUG_KEY_FREQS;
  const snr = Number.isFinite(p.noiseFloorRms) && p.noiseFloorRms > -100
    ? p.rms - p.noiseFloorRms
    : NaN;

  // Compute eqAtKeys if bands provided
  let eqAtKeys = p.eqAtKeys;
  if ((!eqAtKeys || eqAtKeys.length < freqs.length) && p.bands && p.bands.length > 0) {
    eqAtKeys = evaluateCurveAt(p.bands, freqs);
  }

  // Sample key frequencies
  const keySamples = {};
  for (const f of freqs) {
    const raw = sampleDbAtLinearFreq(p.rawSpectrum, p.linearLabels, f);
    const norm = interpLogFreq(p.visFreqs, p.normalizedResponse, f);
    keySamples[f] = { raw, norm };
  }

  // Band snapshot
  const bands = (p.bands || []).map(b =>
    `${b.freq.toFixed(0)}Hz ${b.gain > 0 ? '+' : ''}${b.gain.toFixed(1)}dB Q${b.Q.toFixed(1)}`
  );

  _windows.push({
    t: (p.elapsedMs / 1000).toFixed(1),
    rms: p.rms,
    snr: Number.isFinite(snr) ? snr : null,
    rangeAvg: p.rangeAvg,
    bands: bands.length,
    bandList: bands,
    keySamples,
  });

  // Console: one compact line per window
  const bandStr = bands.length > 0 ? ` bands=${bands.length}` : ' bands=0';
  const snrStr = Number.isFinite(snr) ? ` SNR=${snr.toFixed(1)}` : '';
  const rangeStr = Number.isFinite(p.rangeAvg) ? p.rangeAvg.toFixed(1) : '—';
  console.log(
    `[cal] t=${(p.elapsedMs / 1000).toFixed(1)}s RMS=${p.rms.toFixed(1)}dB${snrStr} range=${rangeStr}dB${bandStr}`
  );
}

/**
 * Record an error during calibration.
 */
export function logCalibrationError(err) {
  if (!_enabled) return;
  const msg = err?.message || String(err);
  _errors.push({ t: _windows.length, msg });
  if (_errors.length <= 5) {
    console.warn(`[cal] ERROR window #${_windows.length}: ${msg}`);
  }
}

/**
 * Mark calibration as converged.
 */
export function logCalibrationConverged(elapsedMs) {
  if (!_enabled) return;
  _convergedAt = (elapsedMs / 1000).toFixed(1);
  console.log(`[cal] ✅ CONVERGED at t=${_convergedAt}s after ${_windows.length} windows`);
}

// ─── Enable / Disable / Reset ─────────────────────────────────────────

export function enableCalibrationLog(mode = 'smart') {
  _enabled = true;
  _windows = [];
  _errors = [];
  _startTime = performance.now();
  _mode = mode;
  _convergedAt = null;

  // Expose to console for easy review
  if (typeof globalThis !== 'undefined') {
    globalThis.__CAL_LOG__ = { dump, summary, clear, windows: () => _windows, errors: () => _errors };
  }
}

export function disableCalibrationLog() {
  _enabled = false;
}

export function resetCalibrationLog() {
  _windows = [];
  _errors = [];
  _convergedAt = null;
}

// ─── Plain-text dump ──────────────────────────────────────────────────

function dump() {
  const lines = [];
  const totalSec = ((performance.now() - _startTime) / 1000).toFixed(1);

  lines.push(`═══ lazyEq Calibration Log ═══`);
  lines.push(`Mode: ${_mode}  |  Duration: ${totalSec}s  |  Windows: ${_windows.length}  |  Errors: ${_errors.length}`);
  if (_convergedAt) lines.push(`Converged: YES at t=${_convergedAt}s`);
  lines.push('');

  // Header
  lines.push('t(s)   RMS(dB) SNR(dB) range(dB) bands');

  for (const w of _windows) {
    const snrStr = w.snr !== null ? w.snr.toFixed(1).padStart(7) : '     —';
    lines.push(
      `${w.t.padStart(5)}  ${w.rms.toFixed(1).padStart(7)} ${snrStr} ${w.rangeAvg.toFixed(1).padStart(9)}  ${w.bands}`
    );
  }

  // Last window band details
  if (_windows.length > 0) {
    const last = _windows[_windows.length - 1];
    if (last.bandList.length > 0) {
      lines.push('');
      lines.push('Last window bands:');
      for (const b of last.bandList) lines.push(`  ${b}`);
    }

    // Key freq snapshot from last window
    lines.push('');
    lines.push('Last window @key freqs (raw_dB → norm_dB):');
    for (const [f, v] of Object.entries(last.keySamples)) {
      const rawStr = Number.isFinite(v.raw) ? v.raw.toFixed(1) : '—';
      const normStr = Number.isFinite(v.norm) ? v.norm.toFixed(1) : '—';
      lines.push(`  ${f}Hz: ${rawStr} → ${normStr}`);
    }
  }

  // Errors
  if (_errors.length > 0) {
    lines.push('');
    lines.push(`Errors (${_errors.length} total${_errors.length > 5 ? ', showing first 5' : ''}):`);
    for (const e of _errors.slice(0, 5)) {
      lines.push(`  window #${e.t}: ${e.msg}`);
    }
  }

  // Health assessment
  lines.push('');
  lines.push('─── Health ───');
  const avgRms = _windows.reduce((s, w) => s + w.rms, 0) / (_windows.length || 1);
  const validRanges = _windows.filter(w => Number.isFinite(w.rangeAvg));
  const avgRange = validRanges.length > 0
    ? validRanges.reduce((s, w) => s + w.rangeAvg, 0) / validRanges.length
    : NaN;
  const avgBands = _windows.reduce((s, w) => s + w.bands, 0) / (_windows.length || 1);
  const errRate = _errors.length / (_windows.length || 1);

  lines.push(`  avg RMS: ${avgRms.toFixed(1)} dB`);
  lines.push(`  avg rangeAvg: ${Number.isFinite(avgRange) ? avgRange.toFixed(1) : '— (no data)'} dB`);
  lines.push(`  avg bands: ${avgBands.toFixed(1)}`);
  lines.push(`  error rate: ${(errRate * 100).toFixed(0)}%`);

  if (avgRms < -60) lines.push(`  ⚠️  RMS too low — mic not receiving speaker signal`);
  if (!Number.isFinite(avgRange)) lines.push(`  ⚠️  No usable signal data in 100-8kHz range — check speaker volume`);
  else if (avgRange < -80) lines.push(`  ⚠️  rangeAvg too low — no usable signal in 100-8kHz`);
  if (errRate > 0.5) lines.push(`  ⚠️  High error rate — check console for details`);
  if (avgBands === 0 && _windows.length > 4) lines.push(`  ⚠️  No EQ bands generated — signal may be too weak`);
  if (_convergedAt) lines.push(`  ✅  Calibration converged successfully`);

  const result = lines.join('\n');
  console.log(result);
  return result;
}

function summary() {
  const totalSec = ((performance.now() - _startTime) / 1000).toFixed(1);
  const avgRms = _windows.reduce((s, w) => s + w.rms, 0) / (_windows.length || 1);
  const errRate = _errors.length / (_windows.length || 1);
  const conv = _convergedAt ? `CONVERGED@${_convergedAt}s` : 'NO_CONVERGENCE';
  const result = `[${_mode}] ${_windows.length}w ${totalSec}s avgRMS=${avgRms.toFixed(1)}dB err=${(errRate * 100).toFixed(0)}% ${conv}`;
  console.log(result);
  return result;
}

function clear() {
  resetCalibrationLog();
  console.log('[cal] Log cleared');
}
