import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRate, formatRate, RATE_POLICY, RATE_MIN, RATE_MAX } from '../src/kernel/rates.js';

test('range boundaries are inclusive and adopt the exact value', () => {
  assert.equal(resolveRate(RATE_MIN).ok, true);
  assert.equal(resolveRate(RATE_MAX).ok, true);
  assert.equal(resolveRate(RATE_MIN).adopted, RATE_MIN);
  assert.equal(resolveRate(RATE_MAX).adopted, RATE_MAX);
});

test('out-of-range rates are rejected with a message naming the range', () => {
  for (const v of [RATE_MIN - 0.001, RATE_MAX + 0.001, 0, -1, 10]) {
    const info = resolveRate(v);
    assert.equal(info.ok, false, `${v} should be rejected`);
    assert.equal(info.rejected, true);
    assert.match(info.message, /超出支持范围/);
  }
});

test('non-numeric input is rejected rather than coerced', () => {
  for (const v of ['fast', NaN, undefined, null, {}]) {
    const info = resolveRate(v);
    assert.equal(info.ok, false);
    assert.equal(info.code, 'NOT_A_NUMBER');
  }
});

test('tier reflects audio quality, and degraded is never silent about it', () => {
  assert.equal(resolveRate(1).tier, 'native');
  assert.equal(resolveRate(0.5).tier, 'guaranteed');
  assert.equal(resolveRate(RATE_POLICY.qualityMin).tier, 'guaranteed');
  assert.equal(resolveRate(RATE_POLICY.qualityMax).tier, 'guaranteed');
  const slow = resolveRate(RATE_POLICY.qualityMin - 0.05);
  assert.equal(slow.tier, 'degraded');
  assert.equal(slow.degraded, true);
  assert.match(slow.message, /音质降级/);
  const fast = resolveRate(RATE_POLICY.qualityMax + 0.05);
  assert.equal(fast.tier, 'degraded');
});

test('adopted rate is rounded to display precision but stays in range', () => {
  const info = resolveRate(0.33333);
  assert.equal(info.adopted, 0.333);
  assert.equal(formatRate(info.adopted), '0.33×');
});
