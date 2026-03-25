'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { filterEdgeSegments } = require('../src/vad');

function makeSegments(ranges) {
  return ranges.map(([start, end]) => ({ start, end }));
}

test('keeps a trailing short cluster when adjacent speech sums past the threshold', () => {
  const segments = makeSegments([
    [210.182, 211.740],
    [217.030, 219.068],
    [219.430, 220.412],
    [220.518, 221.436],
  ]);

  const result = filterEdgeSegments(segments, {
    minEdgeSpeechDuration: 1.0,
    edgeMergeGapSec: 0.3,
  });

  assert.equal(result.ignoredTrailingSegments, 0);
  assert.equal(result.edgeFilterFallback, false);
  assert.equal(result.effectiveSegments.at(-1).end, 221.436);
});

test('still ignores an isolated trailing short noise segment', () => {
  const segments = makeSegments([
    [10.0, 12.2],
    [15.0, 16.4],
    [18.0, 18.7],
  ]);

  const result = filterEdgeSegments(segments, {
    minEdgeSpeechDuration: 1.0,
    edgeMergeGapSec: 0.3,
  });

  assert.equal(result.ignoredTrailingSegments, 1);
  assert.equal(result.effectiveSegments.at(-1).end, 16.4);
});

test('applies the same clustered-edge rule on the leading side', () => {
  const segments = makeSegments([
    [0.000, 0.438],
    [0.520, 1.340],
    [3.000, 6.200],
  ]);

  const result = filterEdgeSegments(segments, {
    minEdgeSpeechDuration: 1.0,
    edgeMergeGapSec: 0.3,
  });

  assert.equal(result.ignoredLeadingSegments, 0);
  assert.equal(result.effectiveSegments[0].start, 0.000);
});

test('falls back to the raw bounds when every edge cluster is too short', () => {
  const segments = makeSegments([
    [0.0, 0.4],
    [1.0, 1.3],
    [2.0, 2.5],
  ]);

  const result = filterEdgeSegments(segments, {
    minEdgeSpeechDuration: 1.0,
    edgeMergeGapSec: 0.3,
  });

  assert.equal(result.edgeFilterFallback, true);
  assert.equal(result.ignoredLeadingSegments, 0);
  assert.equal(result.ignoredTrailingSegments, 0);
  assert.deepEqual(result.effectiveSegments, segments);
});

test('keeps long edge speech unchanged', () => {
  const segments = makeSegments([
    [0.0, 1.4],
    [2.0, 2.8],
    [4.0, 5.6],
  ]);

  const result = filterEdgeSegments(segments, {
    minEdgeSpeechDuration: 1.0,
    edgeMergeGapSec: 0.3,
  });

  assert.equal(result.edgeFilterFallback, false);
  assert.equal(result.ignoredLeadingSegments, 0);
  assert.equal(result.ignoredTrailingSegments, 0);
  assert.deepEqual(result.effectiveSegments, segments);
});
