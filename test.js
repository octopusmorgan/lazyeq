/**
 * Dist smoke test for lazyEq
 * Run with: npm run test:dist (requires an existing dist build)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== lazyEq Test Suite ===\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('✅ PASS:', name);
    passed++;
  } catch (e) {
    console.log('❌ FAIL:', name);
    console.log('   Error:', e.message);
    console.log('   Stack:', e.stack?.split('\n').slice(0, 3).join('\n        '));
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// Test 1: Build exists
test('Build output exists', () => {
  const indexPath = path.join(__dirname, 'dist/index.html');
  assert(fs.existsSync(indexPath), 'dist/index.html not found');
});

// Test 2: Build has canvases
test('HTML has canvas elements', () => {
  const html = fs.readFileSync(path.join(__dirname, 'dist/index.html'), 'utf8');
  assert(html.includes('canvas-spectrum'), 'canvas-spectrum missing');
  assert(html.includes('canvas-estimated'), 'canvas-estimated missing');
  assert(html.includes('canvas-eq'), 'canvas-eq missing');
});

// Test 3: Build has EQ table
test('HTML has EQ table', () => {
  const html = fs.readFileSync(path.join(__dirname, 'dist/index.html'), 'utf8');
  assert(html.includes('eq-table'), 'eq-table missing');
  assert(html.includes('eq-table-container'), 'eq-table-container missing');
});

// Test 4: JS bundle exists and has content
test('JS bundle has content', () => {
  const jsFiles = fs.readdirSync(path.join(__dirname, 'dist/assets')).filter(f => f.endsWith('.js'));
  assert(jsFiles.length > 0, 'No JS files found');
  // Read ALL .js files, not just first
  let totalSize = 0;
  jsFiles.forEach(f => {
    const js = fs.readFileSync(path.join(__dirname, 'dist/assets', f), 'utf8');
    totalSize += js.length;
  });
  assert(totalSize > 1000, 'JS bundle seems too small - only ' + totalSize + ' bytes');
  console.log('   JS bundle size:', totalSize, 'bytes');
});

// Test 5: CSS exists
test('CSS bundle exists', () => {
  const cssFiles = fs.readdirSync(path.join(__dirname, 'dist/assets')).filter(f => f.endsWith('.css'));
  assert(cssFiles.length > 0, 'No CSS files found');
});

// Test 6: Test system included
test('Debug test system included', () => {
  const jsFiles = fs.readdirSync(path.join(__dirname, 'dist/assets')).filter(f => f.endsWith('.js'));
  // Read ALL .js files and verify lazyEqTest exists across combined content
  let combinedContent = '';
  jsFiles.forEach(f => {
    combinedContent += fs.readFileSync(path.join(__dirname, 'dist/assets', f), 'utf8');
  });
  assert(combinedContent.includes('lazyEqTest'), 'lazyEqTest missing from bundle');
});

// Summary
console.log('\n=== Results ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

process.exit(failed > 0 ? 1 : 0);
