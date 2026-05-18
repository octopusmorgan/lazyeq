/**
 * Unit tests for rendering.js — pure canvas rendering functions.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  hexToRgba,
  renderSpectrum,
  renderEQCurve,
  adaptiveSmooth,
} from "../../src/rendering.js";

// --- Global mocks for Node.js ---

if (typeof globalThis.window === "undefined") {
  globalThis.window = {
    devicePixelRatio: 1,
  };
}

// ─── hexToRgba ────────────────────────────────────────────────────────────

describe("hexToRgba", () => {
  test("converts full hex with alpha 0.5", () => {
    assert.equal(hexToRgba("#ff8800", 0.5), "rgba(255, 136, 0, 0.5)");
  });

  test("converts short hex (#RGB) with alpha 1", () => {
    assert.equal(hexToRgba("#f80", 1), "rgba(255, 136, 0, 1)");
  });

  test("handles invalid hex gracefully", () => {
    const result = hexToRgba("not-a-color", 0.8);
    assert.ok(result.startsWith("rgba("));
    // Falls back to black with the given alpha
    assert.equal(result, "rgba(0, 0, 0, 0.8)");
  });

  test("converts with leading hash and alpha 0", () => {
    assert.equal(hexToRgba("#000000", 0), "rgba(0, 0, 0, 0)");
  });

  test("converts #ffffff with alpha 0.75", () => {
    assert.equal(hexToRgba("#ffffff", 0.75), "rgba(255, 255, 255, 0.75)");
  });
});

// ─── adaptiveSmooth ───────────────────────────────────────────────────────

describe("adaptiveSmooth", () => {
  test("all-zero input returns all-zero output", () => {
    const input = new Float32Array(1024);
    const result = adaptiveSmooth(input, 0.85);
    assert.equal(result.length, 1024);
    for (let i = 0; i < result.length; i++) {
      assert.equal(result[i], 0);
    }
  });

  test("single spike spreads energy with smoothing", () => {
    const input = new Float32Array(128);
    input[64] = 100;
    const result = adaptiveSmooth(input, 1.0);
    // Center bin retains highest value
    assert.ok(result[64] > 0);
    // Neighbor bins get some energy
    assert.ok(result[63] > 0);
    assert.ok(result[65] > 0);
    // Far bins remain zero
    assert.equal(result[0], 0);
    assert.equal(result[127], 0);
  });

  test("returns same array reference for short input", () => {
    const input = new Float32Array(3);
    const result = adaptiveSmooth(input, 1.0);
    assert.equal(result, input); // same reference
  });

  test("null/undefined returns null/undefined", () => {
    assert.equal(adaptiveSmooth(null), null);
    assert.equal(adaptiveSmooth(undefined), undefined);
  });
});

// ─── renderSpectrum / renderEQCurve ───────────────────────────────────────

function createMockCanvasContext() {
  const calls = [];
  const mockCtx = {
    canvas: {
      width: 800,
      height: 400,
    },
    _calls: calls,
    clearRect: (...args) => { calls.push(["clearRect", ...args]); },
    fillStyle: null,
    fillRect: (...args) => { calls.push(["fillRect", ...args]); },
    strokeStyle: null,
    lineWidth: null,
    beginPath: () => { calls.push(["beginPath"]); },
    moveTo: (...args) => { calls.push(["moveTo", ...args]); },
    lineTo: (...args) => { calls.push(["lineTo", ...args]); },
    stroke: () => { calls.push(["stroke"]); },
    closePath: () => { calls.push(["closePath"]); },
    fill: () => { calls.push(["fill"]); },
    save: () => { calls.push(["save"]); },
    restore: () => { calls.push(["restore"]); },
    font: null,
    fillText: (...args) => { calls.push(["fillText", ...args]); },
    shadowColor: null,
    shadowBlur: null,
    lineCap: null,
    lineJoin: null,
    setLineDash: () => {},
    createLinearGradient: () => ({
      addColorStop: () => {},
    }),
  };
  // Setter trap for style properties
  return new Proxy(mockCtx, {
    set(target, prop, value) {
      target[prop] = value;
      if (prop !== "_calls") {
        calls.push(["set", prop, value]);
      }
      return true;
    },
    get(target, prop) {
      if (prop === "_calls") return calls;
      return target[prop];
    },
  });
}

// Preserve original devicePixelRatio
const originalDPR = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");

describe("renderSpectrum", () => {
  before(() => {
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
  });
  after(() => {
    if (originalDPR) {
      Object.defineProperty(window, "devicePixelRatio", originalDPR);
    }
  });

  test("renders spectrum with valid data", () => {
    const ctx = createMockCanvasContext();
    const data = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      data[i] = -60 + Math.sin(i * 0.1) * 20;
    }
    renderSpectrum(ctx, data, "#00ff00");
    const calls = ctx._calls;
    // Should call clearRect
    assert.ok(calls.some(([op]) => op === "clearRect"));
    // Should draw grid lines (beginPath × 5 for grid + more for spectrum)
    const beginPathCount = calls.filter(([op]) => op === "beginPath").length;
    assert.ok(beginPathCount >= 5, `expected >= 5 beginPath calls, got ${beginPathCount}`);
    // Should stroke
    assert.ok(calls.some(([op]) => op === "stroke"));
  });

  test("empty data array does not throw", () => {
    const ctx = createMockCanvasContext();
    renderSpectrum(ctx, new Float32Array(0), "#ff6b6b");
    const calls = ctx._calls;
    // clearRect should still happen
    assert.ok(calls.some(([op]) => op === "clearRect"));
  });

  test("null data does not throw", () => {
    const ctx = createMockCanvasContext();
    renderSpectrum(ctx, null, "#ff6b6b");
    assert.ok(ctx._calls.some(([op]) => op === "clearRect"));
  });
});

describe("renderEQCurve", () => {
  before(() => {
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
  });
  after(() => {
    if (originalDPR) {
      Object.defineProperty(window, "devicePixelRatio", originalDPR);
    }
  });

  test("renders EQ curve with valid gains array", () => {
    const ctx = createMockCanvasContext();
    const gains = [0, 1, 2, 1, 0, -1, -2, -1, 0, 1, 0];
    renderEQCurve(ctx, gains);
    const calls = ctx._calls;
    assert.ok(calls.some(([op]) => op === "clearRect"));
    // Should have multiple beginPath calls (grid + zero line + curve + fill)
    const beginPathCount = calls.filter(([op]) => op === "beginPath").length;
    assert.ok(beginPathCount >= 5, `expected >= 5 beginPath calls, got ${beginPathCount}`);
  });

  test("all-zero gains draws a horizontal line (no throw)", () => {
    const ctx = createMockCanvasContext();
    renderEQCurve(ctx, new Float32Array(31));
    assert.ok(ctx._calls.some(([op]) => op === "clearRect"));
  });

  test("empty gains array does not throw", () => {
    const ctx = createMockCanvasContext();
    renderEQCurve(ctx, []);
    // Should show "No EQ data" text
    assert.ok(ctx._calls.some(([op]) => op === "fillText"));
  });
});
