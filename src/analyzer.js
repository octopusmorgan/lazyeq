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

    // Use existing context or create new one
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

  async recordSegment(duration = 3) {
    const framesPerBuffer = FFT_SIZE;
    const totalFrames = Math.ceil((duration * this.audioContext.sampleRate) / framesPerBuffer);
    const frequencyData = new Float32Array(FFT_SIZE / 2);
    let frameCount = 0;
    let scheduledFrameTime = 0; // tracks expected time of next frame

    return new Promise((resolve) => {
      const scheduleNext = (now) => {
        // Compute delay until the next frame is due.
        // Using requestAnimationFrame keeps polling alive even when
        // backgrounded on desktop; audioContext.currentTime is never throttled.
        const delay = Math.max(0, (scheduledFrameTime - now));
        setTimeout(() => requestAnimationFrame(processFrame), delay * 1000);
      };

      const processFrame = (rafTimestamp) => {
        const now = this.audioContext.currentTime;
        const data = new Float32Array(FFT_SIZE / 2);
        this.analyserNode.getFloatFrequencyData(data);

        for (let i = 0; i < data.length; i++) {
          // Convert dB to linear power and accumulate
          frequencyData[i] += Math.pow(10, data[i] / 10);
        }

        frameCount++;

        if (frameCount < totalFrames) {
          // Advance expected time by one buffer duration
          scheduledFrameTime = now + (framesPerBuffer / this.audioContext.sampleRate);
          scheduleNext(now);
        } else {
          const result = new Float32Array(FFT_SIZE / 2);
          for (let i = 0; i < result.length; i++) {
            // Average in linear power, convert back to dB
            const avgPower = frequencyData[i] / frameCount;
            result[i] = 10 * Math.log10(avgPower);
          }
          resolve(result);
        }
      };

      // Bootstrap: capture start time and begin looping
      scheduledFrameTime = this.audioContext.currentTime + (framesPerBuffer / this.audioContext.sampleRate);
      requestAnimationFrame(processFrame);
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
  async recordSweep(duration) {
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
        return null;
      }
    }

    // Create buffer for recording
    const recordingBuffer = new ArrayBuffer(totalSamples * Float32Array.BYTES_PER_ELEMENT);

    // Create worklet node
    const workletNode = new AudioWorkletNode(this.audioContext, 'sweep-recorder');

    // Mute the output to prevent feedback (mic → worklet → speakers)
    const muteGain = this.audioContext.createGain();
    muteGain.gain.value = 0;
    workletNode.connect(muteGain);
    muteGain.connect(this.audioContext.destination);

    return new Promise((resolve) => {
      workletNode.port.onmessage = (e) => {
        if (e.data.type === 'recording-complete') {
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
      this.sourceNode.connect(workletNode);
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
        return avgDB;
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
    const labels = [];
    const isoFreqs = [
      20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160,
      200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
      2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000
    ];
    return isoFreqs;
  }

  getLinearFrequencyLabels() {
    const labels = [];
    const binWidth = this.audioContext.sampleRate / this.analyserNode.fftSize;
    for (let i = 0; i < FFT_SIZE / 2; i++) {
      labels.push(i * binWidth);
    }
    return labels;
  }

  getCurrentSpectrum() {
    // Returns raw spectrum (no mic correction - that's applied later in getCorrectedSpectrumFromDB)
    const data = new Float32Array(FFT_SIZE / 2);
    this.analyserNode.getFloatFrequencyData(data);
    return data;
  }

  // Get overall dB level using RMS (like realtimesoundmeter)
  getRMSLevel() {
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
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    // Don't close audioContext - it's shared across measurements
    this.analyserNode = null;
  }

  stopMicOnly() {
    // Stop just the microphone tracks without destroying the analyzer
    if (this.stream) {
      this.stream.getTracks().forEach(t => {
        if (t.kind === 'audio') {
          t.stop();
          if (import.meta.env.DEV) console.log("Mic track stopped");
        }
      });
      this.stream = null;
    }
  }
}