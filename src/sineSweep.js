/**
 * SineSweepSource - Professional Logarithmic Sine Sweep generator.
 * Used for high-precision frequency response measurement.
 */

import { SAMPLE_RATE } from "./constants.js";

export class SineSweepSource {
  constructor(audioContext) {
    this.audioContext = audioContext;
    this.buffer = null;
    this.sourceNode = null;
    this.gainNode = audioContext.createGain();
    this.gainNode.gain.value = 0.8;
    this.gainNode.connect(this.audioContext.destination);
    this.duration = 8; // Professional standard: 8 seconds
  }

  /**
   * Generate a logarithmic sine sweep from f0 to f1.
   * Formula: f(t) = f0 * (f1/f0)^(t/T)
   * Phase: phi(t) = 2 * pi * f0 * T * ( (f1/f0)^(t/T) - 1 ) / ln(f1/f0)
   */
  createBuffer(duration = 8) {
    this.duration = duration;
    const sampleCount = this.audioContext.sampleRate * duration;
    const buffer = this.audioContext.createBuffer(1, sampleCount, this.audioContext.sampleRate);
    const data = buffer.getChannelData(0);

    const f0 = 20;       // Start frequency
    const f1 = 16000;    // End frequency (16kHz covers useful EQ range, avoids BT speaker compression)
    const T = duration;
    const logRatio = Math.log(f1 / f0);

    for (let i = 0; i < sampleCount; i++) {
      const t = i / this.audioContext.sampleRate;
      // Calculate phase for logarithmic sweep
      const phase = (2 * Math.PI * f0 * T / logRatio) * (Math.exp(logRatio * t / T) - 1);
      
      // Smooth fade-in (10ms linear) and fade-out (200ms exponential) to avoid clicks and speaker compression
      let amplitude = 1.0;
      const fadeInSamples = Math.floor(0.01 * this.audioContext.sampleRate); // 10ms
      const fadeOutSamples = Math.floor(0.2 * this.audioContext.sampleRate); // 200ms
      if (i < fadeInSamples) {
        amplitude = i / fadeInSamples;
      } else if (i > sampleCount - fadeOutSamples) {
        // Exponential fade-out: smooth ramp that avoids triggering speaker limiters
        const fadeProgress = (sampleCount - i) / fadeOutSamples;
        amplitude = Math.pow(fadeProgress, 3); // Cubic fade for extra smoothness
      }

      data[i] = Math.sin(phase) * amplitude;
    }

    this.buffer = buffer;
    return buffer;
  }

  start() {
    if (!this.buffer) {
      this.createBuffer(this.duration);
    }

    if (this.audioContext.state === "suspended") {
      this.audioContext.resume();
    }

    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.buffer;
    this.sourceNode.connect(this.gainNode);
    
    if (import.meta.env.DEV) {
      console.log("Sweep STARTING - playing", this.duration, "seconds");
      console.log("Sample rate:", this.audioContext.sampleRate);
      console.log("Buffer samples:", this.buffer.length);
    }
    
    // Auto-stop and callback when sweep finishes
    this.sourceNode.onended = () => {
      if (import.meta.env.DEV) console.log("Sweep ENDED");
      if (this.onComplete) this.onComplete();
    };
    
    this.sourceNode.start();
  }

  stop() {
    if (this.sourceNode) {
      try {
        this.sourceNode.stop();
      } catch (e) {
        console.warn('Sweep stop error:', e);
      }
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
  }

  setVolume(vol) {
    this.gainNode.gain.setValueAtTime(Math.max(0, Math.min(1, vol)), this.audioContext.currentTime);
  }
}