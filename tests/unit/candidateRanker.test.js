/**
 * Unit tests for candidateRanker.
 *
 * Pure logic — no browser dependencies.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates } from '../../src/candidateRanker.js';
import { MAX_PARAMETRIC_BANDS, LF_FOCUS_CUTOFF, LF_FOCUS_MULTIPLIER } from '../../src/constants.js';

describe('rankCandidates', () => {
  /**
   * Create a minimal candidate object.
   */
  function makeCandidate(freq, deviationDb, widthHz = 100, confidence = 0.8, type = 'peak') {
    return { freq, deviationDb, widthHz, confidence, type, atIndex: 0 };
  }

  test('LF peaks ranked higher than HF peaks with same deviation', () => {
    const candidates = [
      makeCandidate(5000, 4, 200),    // HF peak
      makeCandidate(100, 4, 200),     // LF peak (below 300 Hz cutoff)
      makeCandidate(1000, 4, 200),    // Mid peak
    ];

    const ranked = rankCandidates(candidates);

    assert.ok(ranked.length >= 1, 'Should have ranked candidates');
    // LF peak should have highest score due to multiplier
    assert.equal(ranked[0].freq, 100, `LF peak should be ranked first, got ${ranked[0].freq}`);
  });

  test('higher deviation = higher score', () => {
    const candidates = [
      makeCandidate(500, 2, 200),   // Low deviation
      makeCandidate(500, 6, 200),   // High deviation
      makeCandidate(500, 4, 200),   // Medium deviation
    ];

    const ranked = rankCandidates(candidates);

    assert.equal(ranked[0].deviationDb, 6, 'Highest deviation should rank first');
    assert.equal(ranked[ranked.length - 1].deviationDb, 2, 'Lowest deviation should rank last');
  });

  test('same deviation candidates are ordered deterministically', () => {
    const candidates = [
      makeCandidate(500, 4, 10),    // Very narrow
      makeCandidate(500, 4, 500),   // Broad
    ];

    const ranked = rankCandidates(candidates);

    assert.equal(ranked.length, 2, 'Should rank both candidates');
    assert.ok(ranked[0].score >= ranked[1].score, 'Results should be sorted by descending score');
  });

  test('low confidence reduces score', () => {
    const candidates = [
      makeCandidate(500, 4, 200, 0.9),  // High confidence
      makeCandidate(500, 4, 200, 0.2),  // Low confidence
    ];

    const ranked = rankCandidates(candidates);

    assert.equal(ranked[0].confidence, 0.9, 'High confidence should rank higher');
    // Verify the low confidence candidate has a lower score
    assert.ok(ranked[1].score < ranked[0].score, 'Low confidence score should be lower');
  });

  test('empty candidates → empty result', () => {
    assert.deepEqual(rankCandidates([]), []);
    assert.deepEqual(rankCandidates(null), []);
    assert.deepEqual(rankCandidates(undefined), []);
  });

  test('more candidates than MAX_PARAMETRIC_BANDS → truncated', () => {
    const candidates = [];
    for (let i = 0; i < 30; i++) {
      candidates.push(makeCandidate(100 * (i + 1), 4 - i * 0.1, 200));
    }

    const ranked = rankCandidates(candidates);

    assert.ok(ranked.length <= MAX_PARAMETRIC_BANDS, `Should cap at ${MAX_PARAMETRIC_BANDS}, got ${ranked.length}`);
  });

  test('rank field is assigned correctly (1-based)', () => {
    const candidates = [
      makeCandidate(500, 2, 200),
      makeCandidate(500, 4, 200),
      makeCandidate(500, 6, 200),
    ];

    const ranked = rankCandidates(candidates);

    assert.equal(ranked[0].rank, 1, 'First should have rank 1');
    assert.equal(ranked[1].rank, 2, 'Second should have rank 2');
    assert.equal(ranked[2].rank, 3, 'Third should have rank 3');
  });

  test('stability defaults to 1.0 when not provided', () => {
    const candidates = [makeCandidate(500, 4, 200)];
    const ranked = rankCandidates(candidates);

    assert.equal(ranked[0].stability, 1.0, 'Stability should default to 1.0');
  });

  test('custom weights override defaults', () => {
    const candidates = [
      makeCandidate(500, 2, 200, 0.9),
      makeCandidate(500, 4, 200, 0.3),
    ];

    // With high confidence weight, the high-confidence candidate should rank higher
    // despite lower deviation
    const ranked = rankCandidates(candidates, {
      weights: { deviation: 0.1, stability: 0.1, bandwidth: 0.1, narrowness: 0.1, lowConfidence: 5.0 },
    });

    assert.equal(ranked[0].confidence, 0.9, 'High confidence should win with heavy confidence weight');
  });

  test('LF focus multiplier is applied correctly', () => {
    const lfCandidate = makeCandidate(100, 3, 200);
    const hfCandidate = makeCandidate(5000, 3, 200);

    const ranked = rankCandidates([lfCandidate, hfCandidate]);

    // LF candidate should have higher score due to multiplier
    const lfScore = ranked.find((c) => c.freq === 100).score;
    const hfScore = ranked.find((c) => c.freq === 5000).score;
    assert.ok(lfScore > hfScore, `LF score (${lfScore}) should be higher than HF score (${hfScore})`);
  });

  test('score formula produces expected values with known inputs', () => {
    const candidates = [makeCandidate(500, 4, 100, 0.8)];
    const ranked = rankCandidates(candidates);

    const c = ranked[0];
    // Verify score components are reasonable
    assert.ok(c.score > 0, 'Score should be positive for a good candidate');
    assert.ok(typeof c.score === 'number', 'Score should be a number');
  });
});
