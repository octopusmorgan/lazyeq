/**
 * SweepRecorderProcessor — AudioWorklet node for recording sweep playback.
 * Replaces the deprecated ScriptProcessorNode for capturing audio during sweep measurement.
 *
 * Records raw PCM from the microphone input into a pre-allocated buffer provided
 * by the main thread via postMessage with transfer.
 */
class SweepRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.sampleIndex = 0;
    this.totalSamples = 0;
    this.buffer = null;

    this.port.onmessage = (e) => {
      if (e.data.type === 'start') {
        this.buffer = new Float32Array(e.data.buffer);
        this.totalSamples = e.data.totalSamples;
        this.sampleIndex = 0;
        this.recording = true;
      }
    };
  }

  process(inputs, outputs) {
    if (!this.recording || !this.buffer) {
      return true; // Keep processor alive
    }

    const input = inputs[0];
    if (!input || !input[0]) {
      return true;
    }

    const channelData = input[0];
    const remaining = this.totalSamples - this.sampleIndex;
    const toCopy = Math.min(channelData.length, remaining);

    for (let i = 0; i < toCopy; i++) {
      this.buffer[this.sampleIndex + i] = channelData[i];
    }

    this.sampleIndex += toCopy;

    if (this.sampleIndex >= this.totalSamples) {
      this.recording = false;
      // Transfer the filled buffer back to the main thread
      this.port.postMessage(
        { type: 'recording-complete', buffer: this.buffer.buffer },
        [this.buffer.buffer]
      );
    }

    return true; // Keep processor alive
  }
}

registerProcessor('sweep-recorder', SweepRecorderProcessor);
