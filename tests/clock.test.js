import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoopTimeline, MediaClock } from '../src/kernel/clock.js';

test('loop timeline maps virtual time to source position and pass index', () => {
  const tl = new LoopTimeline({ start: 1, end: 2, repeat: true });
  assert.deepEqual(tl.locate(0), { loopIndex: 0, position: 1 });
  assert.deepEqual(tl.locate(0.5), { loopIndex: 0, position: 1.5 });
  assert.deepEqual(tl.locate(1), { loopIndex: 1, position: 1 });
  assert.deepEqual(tl.locate(1.25), { loopIndex: 1, position: 1.25 });
  assert.equal(tl.locate(3.5).loopIndex, 3);
});

test('non-repeating region clamps to its end after one pass', () => {
  const tl = new LoopTimeline({ start: 0, end: 2, repeat: false });
  assert.deepEqual(tl.locate(1.5), { loopIndex: 0, position: 1.5 });
  const end = tl.locate(2.5);
  assert.equal(end.position, 2);
});

test('virtual position is region-relative, so cuts do not look like drift', () => {
  const tl = new LoopTimeline({ start: 1, end: 1.5, repeat: true });
  assert.equal(tl.virtualFor(1.5), 0.5);
  // The pass index is monotonic even though the concrete position wraps.
  const positions = [];
  for (let v = 0; v < 3; v += 0.05) positions.push(tl.locate(v));
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i].loopIndex >= positions[i - 1].loopIndex);
  }
});

test('media clock applies rate as a slope, not by changing the clock itself', () => {
  const clock = new MediaClock({ rate: 0.5, programAnchor: 0, outputAnchor: 0 });
  assert.equal(clock.now(2), 1);
  clock.setRate(1.25, 2);
  assert.equal(clock.now(2), 1);
  assert.equal(clock.now(4), 3.5);
});

test('paused media clock does not advance program time', () => {
  const clock = new MediaClock({ rate: 1, programAnchor: 0, outputAnchor: 0 });
  clock.pause(1);
  assert.equal(clock.now(5), 1);
  clock.resume(5);
  assert.equal(clock.now(6), 2);
});
