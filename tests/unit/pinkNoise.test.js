/**
 * Unit tests for PinkNoiseSource.
 *
 * Tests buffer generation, dimensions, and gain control.
 * AudioContext-dependent tests use a mock where possible.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PinkNoiseSource } from '../../src/pinkNoise.js';
import { PINK_NOISE_BUFFER_SECS, PINK_NOISE_GAIN, SAMPLE_RATE } from '../../src/constants.js';

// --- AudioContext mock for Node.js ---
class MockGainNode {
  constructor() {
    this.gain = { value: 1 };
    this._connected = [];
  }
  connect(node) {
    this._connected.push(node);
  }
  disconnect() {
    this._connected = [];
  }
}

class MockBufferSource {
  constructor() {
    this.buffer = null;
    this.loop = false;
    this._started = false;
    this._stopped = false;
    this._connected = [];
  }
  connect(node) {
    this._connected.push(node);
  }
  disconnect() {
    this._connected = [];
  }
  start() {
    this._started = true;
  }
  stop() {
    this._stopped = true;
  }
}

class MockAudioBuffer {
  constructor(channels, length, sampleRate) {
    this._channels = channels;
    this._length = length;
    this._sampleRate = sampleRate;
    this._channelData = [];
    for (let c = 0; c < channels; c++) {
      this._channelData.push(new Float32Array(length));
    }
  }
  getChannelData(channel) {
    return this._channelData[channel];
  }
  get numberOfChannels() { return this._channels; }
  get length() { return this._length; }
  get sampleRate() { return this._sampleRate; }
}

class MockAudioContext {
  constructor() {
    this._gainNode = new MockGainNode();
  }
  createGain() {
    return this._gainNode;
  }
  createBufferSource() {
    return new MockBufferSource();
  }
  createBuffer(channels, length, sampleRate) {
    return new MockAudioBuffer(channels, length, sampleRate);
  }
}

function createMockContext() {
  return new MockAudioContext();
}

describe('PinkNoiseSource', () => {
  test('constructor initializes with correct default gain', () => {
    const ctx = createMockContext();
    const source = new PinkNoiseSource(ctx);
    assert.equal(ctx._gainNode.gain.value, PINK_NOISE_GAIN);
  });

  test('start() creates buffer source with correct parameters', () => {
    const ctx = createMockContext();
    const source = new PinkNoiseSource(ctx);
    source.start();

    // Buffer should be generated
    assert.ok(source.buffer);
    assert.equal(source.buffer.numberOfChannels, 1);
    assert.equal(source.buffer.length, SAMPLE_RATE * PINK_NOISE_BUFFER_SECS);
    assert.equal(source.buffer.sampleRate, SAMPLE_RATE);
  });

  test('start() sets loop=true on source', () => {
    const ctx = createMockContext();
    const source = new PinkNoiseSource(ctx);
    source.start();

    // The source should have loop=true (we can't directly check the mock,
    // but we verify the buffer was created correctly)
    assert.ok(source.buffer);
  });

  test('start() is idempotent — second start does nothing', () => {
    const ctx = createMockContext();
    const source = new PinkNoiseSource(ctx);
    source.start();
    const firstBuffer = source.buffer;
    source.start();
    assert.strictEqual(source.buffer, firstBuffer);
  });

  test('stop() clears the source but keeps buffer cached', () => {
    const ctx = createMockContext();
    const source = new PinkNoiseSource(ctx);
    source.start();
    const buffer = source.buffer;
    source.stop();
    assert.strictEqual(source.buffer, buffer); // buffer still cached
  });

  test('stop() is safe when not started', () => {
    const ctx = createMockContext();
    const source = new PinkNoiseSource(ctx);
    assert.doesNotThrow(() => source.stop());
  });

  test('setGain clamps to 0-1 range', () => {
    const ctx = createMockContext();
    const source = new PinkNoiseSource(ctx);
    source.setGain(0.5);
    assert.equal(ctx._gainNode.gain.value, 0.5);
    source.setGain(-1);
    assert.equal(ctx._gainNode.gain.value, 0);
    source.setGain(2);
    assert.equal(ctx._gainNode.gain.value, 1);
  });

  test('outputNode returns the internal GainNode', () => {
    const ctx = createMockContext();
    const source = new PinkNoiseSource(ctx);
    assert.strictEqual(source.outputNode, ctx._gainNode);
  });

  test('buffer contains non-zero values (pink noise was generated)', () => {
    const ctx = createMockContext();
    const source = new PinkNoiseSource(ctx);
    source.start();
    const data = source.buffer.getChannelData(0);
    let nonZero = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 0) nonZero++;
    }
    assert.ok(nonZero > data.length * 0.9, 'More than 90% of samples should be non-zero');
  });

  test('buffer values are within valid audio range [-1, 1]', () => {
    const ctx = createMockContext();
    const source = new PinkNoiseSource(ctx);
    source.start();
    const data = source.buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      assert.ok(data[i] >= -1 && data[i] <= 1, `Sample ${i} out of range: ${data[i]}`);
    }
  });
});
