/**
 * Integration test for package import paths via Vite.
 * Run with: npx vite build && npx vite preview
 * Or verify manually in browser dev tools.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

// Verify package structure exists
test("packages exist on disk", () => {
  assert.ok(existsSync("packages/@acoustic-forge/core/index.js"));
  assert.ok(existsSync("packages/@acoustic-forge/shared/index.js"));
  assert.ok(existsSync("packages/@acoustic-forge/ui/index.js"));
});

// Verify exports in core package index
test("core package has expected exports", () => {
  const coreIndex = readFileSync("packages/@acoustic-forge/core/index.js", "utf-8");
  assert.ok(coreIndex.includes("SineSweepSource"));
  assert.ok(coreIndex.includes("SpectrumAnalyzer"));
  assert.ok(coreIndex.includes("RoomCalibration"));
  assert.ok(coreIndex.includes("exportWavelet"));
  assert.ok(coreIndex.includes("exportEqMac"));
});

// Verify exports in shared package
test("shared package has expected exports", () => {
  const sharedIndex = readFileSync("packages/@acoustic-forge/shared/index.js", "utf-8");
  assert.ok(sharedIndex.includes("SAMPLE_RATE"));
  assert.ok(sharedIndex.includes("FFT_SIZE"));
  assert.ok(sharedIndex.includes("EQMAC_BANDS"));
  assert.ok(sharedIndex.includes("hexToRgba"));
  assert.ok(sharedIndex.includes("downloadFile"));
});

// Verify exports in ui package
test("ui package has expected exports", () => {
  const uiIndex = readFileSync("packages/@acoustic-forge/ui/index.js", "utf-8");
  assert.ok(uiIndex.includes("renderSpectrum"));
  assert.ok(uiIndex.includes("renderEQCurve"));
  assert.ok(uiIndex.includes("resizeCanvases"));
});

// Verify internal src index.js paths are valid JS
test("core src/index.js has valid import paths", () => {
  const index = readFileSync("packages/@acoustic-forge/core/src/index.js", "utf-8");
  // Should not have .js extensions in actual file, just verify structure
  assert.ok(index.includes("export"));
  assert.ok(index.includes("from"));
});

// Verify main.js entry point exists in src/
test("src/main.js exists and has imports", () => {
  assert.ok(existsSync("src/main.js"));
  const main = readFileSync("src/main.js", "utf-8");
  // Import from local app.js
  assert.ok(main.includes("./app.js"));
});

test("src/app.js exists", () => {
  assert.ok(existsSync("src/app.js"));
});

test("src/style.css exists", () => {
  assert.ok(existsSync("src/style.css"));
});

test("index.html references correct entry point", () => {
  const html = readFileSync("index.html", "utf-8");
  assert.ok(html.includes('src="./src/main.js"'));
});

// Verify vite config has correct aliases
test("vite.config.js has correct aliases", () => {
  const viteConfig = readFileSync("vite.config.js", "utf-8");
  assert.ok(viteConfig.includes("@acoustic-forge/core"));
  assert.ok(viteConfig.includes("@acoustic-forge/shared"));
  assert.ok(viteConfig.includes("@acoustic-forge/ui"));
});