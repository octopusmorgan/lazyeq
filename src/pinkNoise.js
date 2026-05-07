/**
 * PinkNoiseSource — generates pink noise via Paul Kellet's method.
 *
 * Pre-generates a 10-second AudioBuffer at 44100 Hz (mono), plays it
 * via AudioBufferSourceNode with loop=true. Exposes start/stop/setGain.
 *
 * Paul Kellet's method: filter white noise through cascaded -3dB/octave
 * shelving filters to produce -3dB/oct spectral slope (pink noise).
 */

import { PINK_NOISE_BUFFER_SECS, PINK_NOISE_GAIN, SAMPLE_RATE } from './constants.js';

export class PinkNoiseSource {
  /**
   * @param {AudioContext} audioContext
   */
  constructor(audioContext) {
    this._ctx = audioContext;
    this._gainNode = this._ctx.createGain();
    this._gainNode.gain.value = PINK_NOISE_GAIN;
    this._gainNode.connect(this._ctx.destination);
    this._source = null;
    this._buffer = null;
  }

  /**
   * Generate pink noise buffer using Paul Kellet's method.
   * Cached after first generation for reuse.
   * @returns {AudioBuffer}
   */
  _generateBuffer() {
    if (this._buffer) return this._buffer;

    const length = SAMPLE_RATE * PINK_NOISE_BUFFER_SECS;
    const buffer = this._ctx.createBuffer(1, length, SAMPLE_RATE);
    const data = buffer.getChannelData(0);

    // Paul Kellet's refined method — cascaded integrators with feedback
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;

    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;

      b0 = 0.99886 * b0 + white * 0.0555179;
      b3 = -0.7651 * b3;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b4 = -0.8517 * b4;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b5 = -0.9322 * b5;
      b6 = -0.99886 * b6;

      data[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    }

    // Normalize to peak ±1.0 for maximum signal level
    let peak = 0;
    for (let i = 0; i < length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }
    if (peak > 0) {
      const scale = 0.99 / peak; // 0.99 to leave 1% headroom
      for (let i = 0; i < length; i++) {
        data[i] *= scale;
      }
    }

    if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
      const rms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
      console.log(`[PinkNoise] buffer normalized: peak=${peak.toFixed(3)} → 0.99 | RMS=${rms.toFixed(3)} (${(20*Math.log10(rms)).toFixed(1)} dBFS) | samples=${length}`);
    }

    this._buffer = buffer;
    return buffer;
  }

  /**
   * Start playing pink noise in a seamless loop.
   */
  start() {
    if (this._source) return; // already playing

    if (this._ctx.state === "suspended") {
      this._ctx.resume();
    }

    const buffer = this._generateBuffer();
    this._source = this._ctx.createBufferSource();
    this._source.buffer = buffer;
    this._source.loop = true;
    // Connect through filter chain if set, otherwise direct to gain
    if (this._filterHead) {
      this._source.connect(this._filterHead);
    } else {
      this._source.connect(this._gainNode);
    }
    this._source.start();
  }

  /**
   * Insert a chain of BiquadFilterNodes between source and gain.
   * Filters must be pre-connected in series. The first filter becomes
   * the new connection target for the source; the last connects to gain.
   *
   * @param {BiquadFilterNode[]} filters — pre-connected chain (f[0]→f[1]→...→f[n-1])
   */
  setFilterChain(filters) {
    if (!filters || filters.length === 0) {
      this._filterHead = null;
      return;
    }
    this._filterHead = filters[0];
    // Ensure last filter connects to gainNode
    filters[filters.length - 1].connect(this._gainNode);
  }

  /**
   * Stop playback. Buffer is kept cached for reuse.
   */
  stop() {
    if (!this._source) return;
    try {
      this._source.stop();
    } catch {
      // Already stopped — ignore
    }
    this._source.disconnect();
    this._source = null;
  }

  /**
   * Set playback gain (0–1).
   * @param {number} val
   */
  setGain(val) {
    this._gainNode.gain.value = Math.max(0, Math.min(1, val));
  }

  /**
   * Get the internal GainNode for external connections.
   * @returns {GainNode}
   */
  get outputNode() {
    return this._gainNode;
  }

  /**
   * Get the cached buffer (null if not yet generated).
   * @returns {AudioBuffer|null}
   */
  get buffer() {
    return this._buffer;
  }
}
