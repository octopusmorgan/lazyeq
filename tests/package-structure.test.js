/**
 * Repository structure checks for the single-app lazyEq setup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

test("required application files exist", () => {
  const required = [
    "src/main.js",
    "src/analyzer.js",
    "src/sineSweep.js",
    "src/eqGenerator.js",
    "src/style.css",
    "src/webrtc/signalingChannel.js",
    "src/webrtc/remoteMicHost.js",
    "src/webrtc/remoteMicClient.js",
    "src/webrtc/networkDiscovery.js",
    "src/webrtc/qrCode.js",
    "server/signaling.js",
    "public/audio-worklet-processor.js",
    "index.html",
    "remote-mic.html",
    "vite.config.js",
  ];
  for (const file of required) {
    assert.ok(existsSync(file), `Missing required file: ${file}`);
  }
});

test("main entrypoint uses local modules (not package aliases)", () => {
  const main = readFileSync("src/main.js", "utf-8");
  assert.ok(main.includes("./sineSweep.js"));
  assert.ok(main.includes("./analyzer.js"));
  assert.ok(main.includes("./eqGenerator.js"));
  assert.ok(main.includes("./webrtc/remoteMicHost.js"));
  assert.ok(!main.includes("@acoustic-forge/"));
});

test("index.html references src/main.js", () => {
  const html = readFileSync("index.html", "utf-8");
  assert.ok(html.includes('src="./src/main.js"'));
});

test("vite config keeps signaling proxy and remote mic entry", () => {
  const viteConfig = readFileSync("vite.config.js", "utf-8");
  assert.ok(viteConfig.includes("'/signaling'"));
  assert.ok(viteConfig.includes("remote-mic.html"));
});
