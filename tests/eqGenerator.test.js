/**
 * Unit tests for eqGenerator (Node — no browser).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exportWavelet,
  exportEqMac,
  generateVisualizationData,
  generateEQCurve,
  generateFlatEQ,
  getHarmanTargetDB,
  EQMAC_BANDS,
} from "../src/eqGenerator.js";

test("EQMAC_BANDS has 10 bands", () => {
  assert.equal(EQMAC_BANDS.length, 10);
});

test("getHarmanTargetDB returns finite values across range", () => {
  assert.ok(Number.isFinite(getHarmanTargetDB(20)));
  assert.ok(Number.isFinite(getHarmanTargetDB(1000)));
  assert.ok(Number.isFinite(getHarmanTargetDB(20000)));
});

test("generateFlatEQ is all zeros", () => {
  const f = generateFlatEQ();
  assert.ok(f.every((x) => x === 0));
});

test("generateVisualizationData respects numPoints", () => {
  const spectrum = new Float32Array(1024).fill(-50);
  const labels = Array.from({ length: 1024 }, (_, i) => i * (44100 / 2048));
  const pts = generateVisualizationData(spectrum, labels, 64);
  assert.equal(pts.length, 64);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i].x >= pts[i - 1].x);
  }
});

test("exportWavelet starts with GraphicEQ and spans bands", () => {
  const z = generateFlatEQ();
  const s = exportWavelet(z);
  assert.ok(s.startsWith("GraphicEQ:"));
  assert.ok(s.includes("20 ") && s.includes("19871"));
});

test("exportEqMac yields valid JSON with one filter per band", () => {
  const gains = new Array(64).fill(0);
  const j = exportEqMac(gains);
  const o = JSON.parse(j);
  assert.equal(o.filters.length, EQMAC_BANDS.length);
  assert.equal(o.filters[0].type, "PK");
});

test("generateEQCurve clamps gains to [-12, 12]", () => {
  const n = 1024;
  const spectrum = new Float32Array(n).fill(50);
  const labels = Array.from({ length: n }, (_, i) => i * (22050 / n));
  const gains = generateEQCurve(spectrum, labels);
  assert.ok(gains.every((g) => g >= -12 && g <= 12));
});
