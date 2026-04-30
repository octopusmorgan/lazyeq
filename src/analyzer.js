/**
 * Mic recorder + FFT spectrum analyzer.
 */

import { SineSweepSource } from "./sineSweep.js";
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

  async init(deviceId = null, existingContext = null) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("getUserMedia not supported");
    }

    // Use existing context or create new one
    this.audioContext = existingContext || new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: SAMPLE_RATE
    });

    // Preserve existing noiseBuffer (don't overwrite calibration data)
    const existingNoiseBuffer = this.noiseBuffer;

    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = FFT_SIZE;
    this.analyserNode.smoothingTimeConstant = 0.3;

    // Restore noiseBuffer after reinitializing
    this.noiseBuffer = existingNoiseBuffer;

    try {
      const constraints = {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      };
      
      // Use selected device if provided
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

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.sourceNode.connect(this.analyserNode);

    return this;
  }

  async recordSegment(duration = 3) {
    const framesPerBuffer = FFT_SIZE;
    const totalFrames = Math.ceil((duration * SAMPLE_RATE) / framesPerBuffer);
    const frequencyData = new Float32Array(FFT_SIZE / 2);
    let frameCount = 0;
    let scheduledFrameTime = 0; // tracks expected time of next frame

    return new Promise((resolve) => {
      const scheduleNext = (now) => {
        // Compute delay until the next frame is due.
        // Using requestAnimationFrame keeps polling alive even when
        // backgrounded on desktop; audioContext.currentTime is never throttled.
        const delay = Math.max(0, (scheduledFrameTime - now));
        setTimeout(() => requestAnimationFrame(processFrame), delay);
      };

      const processFrame = (rafTimestamp) => {
        const now = this.audioContext.currentTime;
        const data = new Float32Array(FFT_SIZE / 2);
        this.analyserNode.getFloatFrequencyData(data);

        for (let i = 0; i < data.length; i++) {
          frequencyData[i] += data[i];
        }

        frameCount++;

        if (frameCount < totalFrames) {
          // Advance expected time by one buffer duration
          scheduledFrameTime = now + (framesPerBuffer / SAMPLE_RATE);
          scheduleNext(now);
        } else {
          const result = new Float32Array(FFT_SIZE / 2);
          for (let i = 0; i < result.length; i++) {
            result[i] = frequencyData[i] / frameCount;
          }
          resolve(result);
        }
      };

      // Bootstrap: capture start time and begin looping
      scheduledFrameTime = this.audioContext.currentTime + (framesPerBuffer / SAMPLE_RATE);
      requestAnimationFrame(processFrame);
    });
  }

  async captureNoiseFloor(duration = 10) {
    this.noiseBuffer = await this.recordSegment(duration);
    return this.noiseBuffer;
  }

  async calibrateMicrophone() {
    // Self-calibration: play test tone through phone speaker, record with phone mic
    // The microphone is already connected to this.analyserNode from init()
    // We just need to play the sweep and capture from the analyser
    try {
      // Create test sweep (1 second)
      const sweep = new SineSweepSource(this.audioContext);
      sweep.createBuffer(1);
      sweep.setVolume(0.5);

      // Connect sweep to speakers (destination)
      sweep.gainNode.connect(this.audioContext.destination);

      // --- FIX: Start the sweep before recording ---
      sweep.start();

      // Record from existing analyser (which is connected to mic via this.stream)
      // Just capture during the sweep
      const recordedSpectrum = await this.recordSegment(1);

      sweep.stop();

      // Calculate correction curve
      // The recorded spectrum is the COMBINED response of: speaker + mic + room
      // We want just the mic response, so we subtract an assumed flat speaker response
      // For simplicity, we subtract the average level to "flatten" the response
      // This gives us the mic's fingerprint
      if (recordedSpectrum && recordedSpectrum.length > 0) {
        // Check if we captured actual signal (not just silence)
        let maxDB = -Infinity;
        for (let i = 0; i < recordedSpectrum.length; i++) {
          if (recordedSpectrum[i] > maxDB) maxDB = recordedSpectrum[i];
        }

        // If max is below -80dB, calibration failed (mic didn't capture sweep)
        if (maxDB < -80) {
          console.warn("Mic calibration: weak signal detected, skipping correction");
          this.micCorrectionCurve = null;
          return true;
        }

        // Calculate average level (approximate "flat" response of speaker)
        let sum = 0;
        let count = 0;
        for (let i = 0; i < recordedSpectrum.length; i++) {
          if (recordedSpectrum[i] > -100) { // Ignore silent bins
            sum += recordedSpectrum[i];
            count++;
          }
        }
        const avgLevel = count > 0 ? sum / count : -50;

        // Correction = what we measured (mic's impression of a "flat" signal)
        // Store this as the correction to apply later
        this.micCorrectionCurve = new Float32Array(recordedSpectrum.length);
        for (let i = 0; i < recordedSpectrum.length; i++) {
          // Subtract average to normalize, result is how mic colors sound
          this.micCorrectionCurve[i] = recordedSpectrum[i] - avgLevel;
        }
        if (import.meta.env.DEV) {
          console.log("Mic self-calibration complete, avg level:", avgLevel.toFixed(1));
        }
      }

      return true;
    } catch (err) {
      console.error("Mic calibration failed:", err);
      this.micCorrectionCurve = null;
      return false;
    }
  }

  async captureSpeaker(duration = 5) {
    return await this.recordSegment(duration);
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
    const binWidth = SAMPLE_RATE / FFT_SIZE;
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