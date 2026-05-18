/**
 * HTML structure tests for the single calibration card layout.
 *
 * Verifies that all required IDs are present after the wizard-to-card
 * restructuring (T006). This ensures PR-3 can wire up elements correctly.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf-8');

describe('HTML structure — single calibration card', () => {
  test('5-step wizard cards are removed', () => {
    assert.ok(!html.includes('id="step-devices"'), 'step-devices should be removed');
    assert.ok(!html.includes('id="step-noise"'), 'step-noise should be removed');
    assert.ok(!html.includes('id="step-sweep"'), 'step-sweep should be removed');
    assert.ok(!html.includes('id="step-results"'), 'step-results should be removed');
    assert.ok(!html.includes('id="step-export"'), 'step-export should be removed');
    assert.ok(!html.includes('id="btn-noise"'), 'btn-noise should be removed');
    assert.ok(!html.includes('id="btn-sweep"'), 'btn-sweep should be removed');
    // btn-stop (sweep stop button) is removed; btn-stop-calibration is the new one
    assert.ok(!html.includes('id="btn-stop"'), 'btn-stop (sweep) should be removed');
  });

  test('btn-refresh-devices preserved inside details', () => {
    assert.ok(html.includes('id="btn-refresh-devices"'), 'btn-refresh-devices should exist');
  });

  test('single calibration card exists', () => {
    assert.ok(html.includes('id="calibration-card"'), 'calibration-card should exist');
  });
});

describe('HTML structure — preserved IDs', () => {
  test('mic setup section and device selector preserved', () => {
    assert.ok(html.includes('id="mic-setup-section"'), 'mic-setup-section should exist');
    assert.ok(html.includes('id="mic-select"'), 'mic-select should exist');
    assert.ok(html.includes('id="btn-refresh-devices"'), 'btn-refresh-devices should exist');
    assert.ok(html.includes('id="status-devices"'), 'status-devices should exist');
  });

  test('remote mic panel IDs removed (deprecated)', () => {
    // Remote Mic feature was deprecated - these IDs should no longer exist
    assert.ok(!html.includes('id="remote-mic-panel"'), 'remote-mic-panel should be removed');
    assert.ok(!html.includes('id="remote-mic-server"'), 'remote-mic-server should be removed');
    assert.ok(!html.includes('id="btn-remote-mic"'), 'btn-remote-mic should be removed');
  });

  test('canvas IDs preserved for results rendering', () => {
    assert.ok(html.includes('id="canvas-spectrum"'), 'canvas-spectrum should exist');
    assert.ok(html.includes('id="canvas-estimated"'), 'canvas-estimated should exist');
    assert.ok(html.includes('id="canvas-eq"'), 'canvas-eq should exist');
    assert.ok(html.includes('id="canvas-live"'), 'canvas-live should exist (new)');
  });

  test('EQ table ID preserved', () => {
    assert.ok(html.includes('id="eq-table"'), 'eq-table should exist');
    assert.ok(html.includes('id="eq-table-container"'), 'eq-table-container should exist');
  });

  test('export button IDs preserved', () => {
    assert.ok(html.includes('id="btn-export-wavelet"'), 'btn-export-wavelet should exist');
    assert.ok(html.includes('id="btn-export-eqmac"'), 'btn-export-eqmac should exist');
    assert.ok(html.includes('id="status-export"'), 'status-export should exist');
  });
});

describe('HTML structure — new elements', () => {
  test('calibrate button exists', () => {
    assert.ok(html.includes('id="btn-calibrate"'), 'btn-calibrate should exist');
  });

  test('stop calibration button exists (initially hidden)', () => {
    assert.ok(html.includes('id="btn-stop-calibration"'), 'btn-stop-calibration should exist');
    assert.ok(html.includes('btn-stop-calibration hidden'), 'btn-stop-calibration should have hidden class');
  });

  test('calibration delta display exists', () => {
    assert.ok(html.includes('id="calibration-delta"'), 'calibration-delta should exist');
  });

  test('mic setup is wrapped in collapsible details', () => {
    assert.ok(html.includes('<details id="mic-setup-section"'), 'mic-setup-section should be a details element');
    assert.ok(html.includes('<summary'), 'should have summary element');
  });

  test('advanced section exists as collapsed details', () => {
    assert.ok(html.includes('id="advanced-section"'), 'advanced-section should exist');
    assert.ok(html.includes('<details id="advanced-section"'), 'advanced-section should be a details element');
  });

  test('results section is hidden by default', () => {
    assert.ok(html.includes('id="results-section"'), 'results-section should exist');
    assert.ok(html.includes('results-section hidden'), 'results-section should have hidden class');
  });

  test('canvas-live has appropriate dimensions', () => {
    assert.ok(html.includes('width="800"'), 'canvas-live should have width');
    assert.ok(html.includes('height="300"'), 'canvas-live should have height');
  });
});

describe('HTML structure — step indicators removed', () => {
  test('no step-indicator spans remain', () => {
    assert.ok(!html.includes('class="step-indicator"'), 'step-indicator class should be removed');
  });

  test('no step-progress elements remain', () => {
    assert.ok(!html.includes('id="calibration-step-indicator"'), 'calibration-step-indicator should be removed');
  });

  test('no sweep progress elements remain', () => {
    assert.ok(!html.includes('id="sweep-progress-container"'), 'sweep-progress-container should be removed');
    assert.ok(!html.includes('id="sweep-progress-bar"'), 'sweep-progress-bar should be removed');
  });

  test('no noise progress elements remain', () => {
    assert.ok(!html.includes('id="noise-progress-container"'), 'noise-progress-container should be removed');
    assert.ok(!html.includes('id="noise-progress-bar"'), 'noise-progress-bar should be removed');
  });
});
