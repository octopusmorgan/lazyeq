/**
 * Mic recorder + FFT spectrum analyzer.
 */

import { SAMPLE_RATE, FFT_SIZE, MIC_REFERENCE_OFFSET } from "./constants.js";

export class SpectrumAnalyzer {
  constructor() {
    this.audioContext = null;
    this.analyserNode = null;
    this.stream = null;
    this.sourceNode = null;
    this.noiseBuffer = null;
    this.micCorrectionCurve = null;
    this._ownsContext = false;
    this._ownsStream = false;
    this._measuring = false;
    this._workletLoaded = false;
    this._workletFailed = false;
  }

  /**
   * Initialize the analyzer.
   *
   * Supports three call signatures for backward compatibility:
   *   1. init()                          — default local mic
   *   2. init(deviceId, existingContext) — legacy string call
   *   3. init({ deviceId, existingContext, remoteStream }) — explicit options object
   *   4. init(mediaStream, existingContext) — pass a MediaStream directly as remote mic
   */
  async init(arg1 = null, arg2 = null) {
    let deviceId = null;
    let remoteStream = null;
    let existingContext = null;

    // Duck-type MediaStream: some browsers/contexts fail instanceof
    const isMediaStream = arg1 && typeof arg1 === "object" && typeof arg1.getTracks === "function";
    if (isMediaStream) {
      remoteStream = arg1;
      existingContext = arg2;
    } else if (arg1 && typeof arg1 === "object") {
      deviceId = arg1.deviceId ?? null;
      remoteStream = arg1.remoteStream ?? null;
      existingContext = arg1.existingContext ?? arg2;
    } else {
      deviceId = arg1;
      existingContext = arg2;
    }

    // Stop old stream tracks if re-initializing (release mic hardware) — only if we own them
    if (this.stream) {
      if (this._ownsStream) {
        this.stream.getTracks().forEach(t => t.stop());
      }
      this.stream = null;
      this._ownsStream = false;
    }

    // Disconnect old sourceNode if re-initializing
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    // Close old AudioContext if we owned it and it's different from the new one
    if (this.audioContext && this._ownsContext && this.audioContext !== existingContext) {
      this.audioContext.close().catch(() => {});
    }

    // Use existing context or create new one
    this._ownsContext = !existingContext;
    this.audioContext = existingContext || new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: SAMPLE_RATE
    });

    // Preserve existing calibration data across re-initializations
    const existingNoiseBuffer = this.noiseBuffer;
    const existingMicCorrectionCurve = this.micCorrectionCurve;

    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = FFT_SIZE;
    this.analyserNode.smoothingTimeConstant = 0;

    // Restore calibration data
    this.noiseBuffer = existingNoiseBuffer;
    this.micCorrectionCurve = existingMicCorrectionCurve;

    if (remoteStream) {
      // Remote mic mode: stream comes from WebRTC (no local getUserMedia needed)
      this.stream = remoteStream;
      this._ownsStream = false;
      if (import.meta.env.DEV) console.log("Analyzer using REMOTE stream:", remoteStream.id, "tracks:", remoteStream.getAudioTracks().length);
    } else {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("getUserMedia not supported");
      }

      try {
        const constraints = {
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        };

        if (deviceId) {
          constraints.audio.deviceId = { exact: deviceId };
          if (import.meta.env.DEV) console.log("Using selected mic device:", deviceId);
        }

        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        this._ownsStream = true;
      } catch (err) {
        if (err.name === "NotAllowedError") {
          throw new Error("Mic permission denied");
        } else if (err.name === "NotFoundError") {
          throw new Error("No microphone found");
        }
        throw err;
      }
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.sourceNode.connect(this.analyserNode);

    return this;
  }

  /**
   * Fail-fast guard: throw if the analyzer has not been initialized.
   */
  _ensureInitialized() {
    if (!this.analyserNode) {
      throw new Error("Analyzer not initialized");
    }
  }

  /**
   * Start continuous spectral measurement with power-domain averaging.
   *
   * Polls getFloatFrequencyData at intervalMs intervals, accumulates via
   * power-domain averaging (same math as recordSegment), and calls the
   * callback with each accumulated result.
   *
   * @param {function} callback - Receives { spectrum: Float32Array, rms: number, elapsedMs: number }
   * @param {number} intervalMs - Polling interval in milliseconds (default: 500)
   * @returns {{ stop: () => void }} Control object to halt measurement
   */
  measureContinuous(callback, intervalMs = 500) {
    this._ensureInitialized();
    if (this._measuring) {
      throw new Error("Measurement already in progress");
    }

    this._measuring = true;
    const binCount = FFT_SIZE / 2;
    const accumulatedPower = new Float32Array(binCount);
    let frameCount = 0;
    const startTime = performance.now();
    let stopped = false;

    const tick = () => {
      if (stopped) return;

      try {
        const data = new Float32Array(binCount);
        this.analyserNode.getFloatFrequencyData(data);

        // Power-domain accumulation (identical math as recordSegment)
        for (let i = 0; i < binCount; i++) {
          accumulatedPower[i] += Math.pow(10, data[i] / 10);
        }
        frameCount++;

        // Convert average back to dB
        const spectrum = new Float32Array(binCount);
        for (let i = 0; i < binCount; i++) {
          const avgPower = accumulatedPower[i] / frameCount;
          spectrum[i] = 10 * Math.log10(avgPower);
        }

        const rms = this.getRMSLevel();
        const elapsedMs = performance.now() - startTime;

        callback({ spectrum, rms, elapsedMs });
      } catch (err) {
        stopped = true;
        this._measuring = false;
        console.error('measureContinuous callback error:', err);
      }

      if (!stopped) {
        setTimeout(tick, intervalMs);
      }
    };

    tick();

    return {
      stop: () => {
        stopped = true;
        this._measuring = false;
      }
    };
  }

  async recordSegment(duration = 3) {
    if (duration <= 0 || !Number.isFinite(duration)) {
      throw new Error("recordSegment: duration must be a positive finite number");
    }
    this._ensureInitialized();
    // Mutex: prevent recordSegment while continuous measurement is active
    if (this._measuring) {
      throw new Error("Measurement already in progress");
    }

    this._measuring = true;
    const framesPerBuffer = FFT_SIZE;
    const totalFrames = Math.ceil((duration * this.audioContext.sampleRate) / framesPerBuffer);
    const frequencyData = new Float32Array(FFT_SIZE / 2);
    let frameCount = 0;

    return new Promise((resolve, reject) => {
      // Use setInterval with audioContext.currentTime for reliable scheduling.
      // RAF+setTimeout are heavily throttled in background tabs; setInterval
      // combined with currentTime-based timing keeps recording accurate.
      const bufferDuration = framesPerBuffer / this.audioContext.sampleRate;
      const intervalMs = Math.round(bufferDuration * 1000);

      const intervalId = setInterval(() => {
        try {
          const data = new Float32Array(FFT_SIZE / 2);
          this.analyserNode.getFloatFrequencyData(data);

          for (let i = 0; i < data.length; i++) {
            // Convert dB to linear power and accumulate
            frequencyData[i] += Math.pow(10, data[i] / 10);
          }

          frameCount++;

          if (frameCount >= totalFrames) {
            clearInterval(intervalId);
            const result = new Float32Array(FFT_SIZE / 2);
            for (let i = 0; i < result.length; i++) {
              // Average in linear power, convert back to dB
              const avgPower = frequencyData[i] / frameCount;
              result[i] = 10 * Math.log10(avgPower);
            }
            this._measuring = false;
            resolve(result);
          }
        } catch (err) {
          clearInterval(intervalId);
          this._measuring = false;
          reject(err);
        }
      }, intervalMs);
    });
  }

  async captureNoiseFloor(duration = 10) {
    this.noiseBuffer = await this.recordSegment(duration);
    return this.noiseBuffer;
  }

  /**
   * Build a generic microphone correction curve for typical phone MEMS microphones.
   *
   * NOTE: This is a GENERIC approximation based on averaged measurements from
   * common smartphone MEMS capsules. It is NOT a per-device calibration.
   * For accurate results, a proper per-device measurement with a calibrated
   * reference microphone would be needed.
   *
   * The curve captures the typical roll-off and resonances of phone mics:
   * - Flat response up to ~2kHz (reference point at 1kHz = 0dB)
   * - Slight presence bump around 4kHz
   * - Gradual high-frequency roll-off above 8kHz (physical limitation of small capsules)
   */
  async calibrateMicrophone() {
    // Generic phone mic correction curve (frequency in Hz → dB correction)
    // These values represent the TYPICAL deviation from flat response.
    // Positive dB = mic over-represents that frequency (we subtract it later).
    // Negative dB = mic under-represents that frequency (we add it back later).
    const GENERIC_PHONE_MIC_CORRECTION = [
      { freq: 1000,  db: 0 },    // Reference point
      { freq: 2000,  db: 0 },    // Still flat
      { freq: 4000,  db: 0.5 },  // Slight presence bump
      { freq: 6000,  db: 0 },    // Back to flat
      { freq: 8000,  db: -1.0 }, // Beginning of HF roll-off
      { freq: 10000, db: -2.0 }, // Moderate roll-off
      { freq: 12500, db: -3.0 }, // Increasing roll-off
      { freq: 16000, db: -4.0 }, // Significant roll-off
      { freq: 20000, db: -6.0 }, // Near Nyquist limit
    ];

    // Interpolate the generic curve to match our FFT bins.
    // We use log-frequency interpolation because audio perception is logarithmic.
    const binCount = FFT_SIZE / 2;
    const binWidth = this.audioContext.sampleRate / this.analyserNode.fftSize;
    this.micCorrectionCurve = new Float32Array(binCount);

    for (let i = 0; i < binCount; i++) {
      const freq = i * binWidth;
      this.micCorrectionCurve[i] = this._interpolateLogFrequency(
        GENERIC_PHONE_MIC_CORRECTION,
        freq
      );
    }

    if (import.meta.env.DEV) {
      console.log("Mic calibration: generic phone mic curve applied (" + binCount + " bins)");
    }

    return true;
  }

  /**
   * Interpolate a correction value at a given frequency using log-frequency interpolation.
   * Extrapolates flat (0 dB slope) beyond the defined range.
   *
   * @param {Array<{freq: number, db: number}>} curve - Breakpoint definition
   * @param {number} targetFreq - Frequency to interpolate
   * @returns {number} Interpolated dB correction value
   */
  _interpolateLogFrequency(curve, targetFreq) {
    // Below the first breakpoint: use the first value (flat extrapolation)
    if (targetFreq <= curve[0].freq) {
      return curve[0].db;
    }
    // Above the last breakpoint: use the last value (flat extrapolation)
    if (targetFreq >= curve[curve.length - 1].freq) {
      return curve[curve.length - 1].db;
    }

    // Find the two surrounding breakpoints
    let lower = curve[0];
    let upper = curve[1];
    for (let i = 0; i < curve.length - 1; i++) {
      if (targetFreq >= curve[i].freq && targetFreq <= curve[i + 1].freq) {
        lower = curve[i];
        upper = curve[i + 1];
        break;
      }
    }

    // Linear interpolation in log-frequency space
    const logLower = Math.log10(lower.freq);
    const logUpper = Math.log10(upper.freq);
    const logTarget = Math.log10(targetFreq);

    const ratio = (logTarget - logLower) / (logUpper - logLower);
    return lower.db + ratio * (upper.db - lower.db);
  }

  /**
   * Compute the power-averaged noise floor level from the stored noiseBuffer.
   *
   * Converts each bin from dB to linear power, averages the power across
   * all valid bins (> -100 dB), then converts back to dB.
   *
   * @returns {number} Noise floor level in dB, or -100 if no noise buffer
   */
  getNoiseFloorRMS() {
    if (!this.noiseBuffer) return -100;

    let totalPower = 0;
    let validBins = 0;

    for (let i = 0; i < this.noiseBuffer.length; i++) {
      const db = this.noiseBuffer[i];
      if (db > -100) {
        totalPower += Math.pow(10, db / 10);
        validBins++;
      }
    }

    if (validBins === 0) return -100;

    const avgPower = totalPower / validBins;
    return 10 * Math.log10(avgPower);
  }

  async captureSpeaker(duration = 5) {
    return await this.recordSegment(duration);
  }

  /**
   * Record a sweep playback using AudioWorklet (replaces deprecated ScriptProcessorNode).
   * Captures raw PCM from the microphone input into a pre-allocated buffer.
   *
   * @param {number} duration - Expected sweep duration in seconds
   * @returns {Promise<Float32Array>} Raw PCM recording of the sweep
   */
  async recordSweep(duration = 3) {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("recordSweep: duration must be a positive finite number");
    }
    this._ensureInitialized();
    if (this._measuring) {
      throw new Error("Measurement already in progress");
    }

    this._measuring = true;
    const sampleRate = this.audioContext.sampleRate;
    // Add 500ms buffer for room decay time
    const totalSamples = Math.ceil((duration + 0.5) * sampleRate);

    // Load the AudioWorklet module (only needs to be done once per context)
    if (!this._workletLoaded) {
      try {
        await this.audioContext.audioWorklet.addModule('/audio-worklet-processor.js');
        this._workletLoaded = true;
      } catch (err) {
        console.warn('[Analyzer] AudioWorklet failed to load, falling back to AnalyserNode polling:', err.message);
        this._workletFailed = true;
        this._workletLoaded = true;
        this._measuring = false;
        return null;
      }
    }

    // Create buffer for recording
    const recordingBuffer = new ArrayBuffer(totalSamples * Float32Array.BYTES_PER_ELEMENT);

    // Create worklet node — fail fast if worklet previously failed to load
    if (this._workletFailed) {
      this._measuring = false;
      return null;
    }

    let workletNode;
    try {
      workletNode = new AudioWorkletNode(this.audioContext, 'sweep-recorder');
    } catch (err) {
      console.warn('[Analyzer] AudioWorkletNode creation failed:', err.message);
      this._workletFailed = true;
      this._measuring = false;
      return null;
    }

    // Mute the output to prevent feedback (mic → worklet → speakers)
    const muteGain = this.audioContext.createGain();
    muteGain.gain.value = 0;
    workletNode.connect(muteGain);
    muteGain.connect(this.audioContext.destination);

    return new Promise((resolve, reject) => {
      const timeoutMs = duration * 1.5 * 1000 + 2000;
      const timeoutId = setTimeout(() => {
        this._measuring = false;
        this.sourceNode?.disconnect(workletNode);
        workletNode.disconnect();
        muteGain.disconnect();
        reject(new Error(`recordSweep timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      workletNode.port.onmessage = (e) => {
        if (e.data.type === 'recording-complete') {
          clearTimeout(timeoutId);
          this._measuring = false;
          this.sourceNode?.disconnect(workletNode);
          workletNode.disconnect();
          muteGain.disconnect();
          // Reconstruct Float32Array from the transferred ArrayBuffer
          const recordedData = new Float32Array(e.data.buffer);
          resolve(recordedData);
        }
      };

      // Start recording by transferring the buffer to the worklet
      workletNode.port.postMessage({
        type: 'start',
        buffer: recordingBuffer,
        totalSamples: totalSamples
      }, [recordingBuffer]);

      // Connect the microphone source to the worklet (splits from existing analyser path)
      this.sourceNode?.connect(workletNode);
    });
  }

  getCorrectedSpectrumFromDB(avgDB) {
    if (!avgDB) return null;

    const result = new Float32Array(avgDB.length);

    if (!this.noiseBuffer) {
      // No noise buffer, just apply mic correction if available
      if (this.micCorrectionCurve) {
        for (let i = 0; i < result.length; i++) {
          result[i] = avgDB[i] - this.micCorrectionCurve[i];
        }
      } else {
        return new Float32Array(avgDB);
      }
      return result;
    }

    for (let i = 0; i < result.length; i++) {
      const signalLinear = Math.pow(10, avgDB[i] / 10);
      const noiseLinear = Math.pow(10, this.noiseBuffer[i] / 10);

      if (signalLinear > noiseLinear * 1.5) {
        result[i] = 10 * Math.log10(signalLinear - noiseLinear);
      } else {
        result[i] = avgDB[i];
      }

      // Apply mic correction if available
      if (this.micCorrectionCurve) {
        result[i] = result[i] - this.micCorrectionCurve[i];
      }
    }

    return result;
  }

  getFrequencyLabels() {
    // Standard ISO 1/3 octave frequencies (20Hz - 20kHz)
    const isoFreqs = [
      20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160,
      200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
      2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000
    ];
    return isoFreqs;
  }

  getLinearFrequencyLabels() {
    this._ensureInitialized();
    const labels = [];
    const binWidth = this.audioContext.sampleRate / this.analyserNode.fftSize;
    for (let i = 0; i < FFT_SIZE / 2; i++) {
      labels.push(i * binWidth);
    }
    return labels;
  }

  getCurrentSpectrum() {
    this._ensureInitialized();
    // Returns raw spectrum (no mic correction - that's applied later in getCorrectedSpectrumFromDB)
    const data = new Float32Array(FFT_SIZE / 2);
    this.analyserNode.getFloatFrequencyData(data);
    return data;
  }

  // Get overall dB level using RMS (like realtimesoundmeter)
  getRMSLevel() {
    this._ensureInitialized();
    const bufferSize = 2048;
    const dataArray = new Float32Array(bufferSize);
    this.analyserNode.getFloatTimeDomainData(dataArray);
    
    let sumSquares = 0;
    let maxVal = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sumSquares += dataArray[i] * dataArray[i];
      maxVal = Math.max(maxVal, Math.abs(dataArray[i]));
    }
    const rms = Math.sqrt(sumSquares / bufferSize);
    
    // Convert to approximate dB
    // Note: This is reference-level, actual dB SPL depends on device mic sensitivity
    // Using MIC_REFERENCE_OFFSET as baseline calibration for typical phone mic
    if (rms < 0.00001) return -100;
    const db = 20 * Math.log10(rms) + MIC_REFERENCE_OFFSET;
    return db;
  }

  destroy() {
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.stream) {
      if (this._ownsStream) {
        this.stream.getTracks().forEach(t => t.stop());
      }
      this.stream = null;
      this._ownsStream = false;
    }
    if (this._ownsContext && this.audioContext) {
      this.audioContext.close().catch(() => {});
      this._ownsContext = false;
    }
    this.analyserNode = null;
    this._workletLoaded = false;
    this._workletFailed = false;
    this._measuring = false;
  }

  stopMicOnly() {
    // Stop just the microphone tracks without destroying the analyzer — only if we own them
    if (this.stream) {
      if (this._ownsStream) {
        this.stream.getTracks().forEach(t => {
          if (t.kind === 'audio') {
            t.stop();
            if (import.meta.env.DEV) console.log("Mic track stopped");
          }
        });
      }
      this.stream = null;
      this._ownsStream = false;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    this._measuring = false;
  }
}
