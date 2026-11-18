import test from 'node:test';
import assert from 'node:assert/strict';
import { Wsola } from '../src/kernel/wsola.js';

const SR = 48000;

function tone(freq, seconds, sr = SR, amp = 0.5, phase = 0) {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freq * (i / sr) + phase);
  return out;
}

function zeroCrossFreq(x, sr = SR) {
  let zc = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] <= 0 && x[i] > 0) zc++;
  return (zc * sr) / x.length;
}

function rms(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

function maxStep(x, from = 1, to = x.length) {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

test('stretch duration tracks requested rate', () => {
  const src = tone(440, 2.0);
  for (const rate of [0.25, 0.5, 0.8, 1.25]) {
    const out = Wsola.stretch([src], { sampleRate: SR, rate })[0];
    const expected = src.length / rate;
    const errorMs = Math.abs(out.length - expected) / SR * 1000;
    assert.ok(errorMs < 20, `rate ${rate}: ${out.length} vs ${expected} (${errorMs.toFixed(1)}ms)`);
  }
});

test('pitch is preserved across rate changes', () => {
  for (const freq of [220, 440, 880]) {
    const src = tone(freq, 1.0);
    for (const rate of [0.5, 0.75, 1.25]) {
      const out = Wsola.stretch([src], { sampleRate: SR, rate })[0];
      const measured = zeroCrossFreq(out.subarray(SR * 0.1, out.length - SR * 0.1));
      assert.ok(
        Math.abs(measured - freq) / freq < 0.01,
        `${freq}Hz at ${rate}x measured ${measured.toFixed(1)}Hz`,
      );
    }
  }
});

test('output is continuous (no splice clicks) and level is stable', () => {
  const src = tone(440, 1.0, SR, 0.5);
  const out = Wsola.stretch([src], { sampleRate: SR, rate: 0.5 })[0];
  const mid = out.subarray(SR * 0.2, out.length - SR * 0.2);
  const step = maxStep(mid);
  // A 440Hz sine at 48k has max sample delta ~ 0.5*2*pi*440/48000 = 0.0288.
  assert.ok(step < 0.06, `max step ${step} suggests a discontinuity`);
  const window = SR / 10;
  let minRms = Infinity;
  for (let i = 0; i + window < mid.length; i += window) minRms = Math.min(minRms, rms(mid, i, i + window));
  assert.ok(minRms > 0.25, `quiet window (min rms ${minRms}) suggests dropouts`);
});

test('stereo channels stay phase-coherent', () => {
  const left = tone(440, 1.0, SR, 0.5);
  const right = tone(440, 1.0, SR, 0.5, Math.PI / 2);
  const [l, r] = Wsola.stretch([left, right], { sampleRate: SR, rate: 0.6 });
  let dot = 0, le = 0, re = 0;
  for (let i = 0; i < l.length; i++) { dot += l[i] * r[i]; le += l[i] * l[i]; re += r[i] * r[i]; }
  const corr = dot / Math.sqrt(le * re);
  // 90 degrees apart => correlation ~0, but should be stable, not collapses.
  assert.ok(Math.abs(corr) < 0.1, `correlation drifted to ${corr}`);
  assert.ok(le > 0 && re > 0);
});

test('streaming render reaches target duration once end-of-input is signalled', () => {
  for (const rate of [0.25, 0.5, 1.25]) {
    const wsola = new Wsola({ sampleRate: SR, channels: 1 });
    wsola.setRate(rate);
    const src = tone(330, 1.0);
    wsola.push([src], 0);
    wsola.endOfInput();
    const totalOut = Math.round(src.length / rate);
    const out = new Float32Array(totalOut + 4096);
    let written = 0;
    const block = 512;
    const tmp = [new Float32Array(block)];
    let starved = 0;
    while (written < totalOut) {
      const n = wsola.render(tmp);
      if (n === 0) { starved++; break; }
      if (n < block) starved++;
      out.set(tmp[0].subarray(0, n), written);
      written += n;
    }
    const errorMs = Math.abs(written - totalOut) / SR * 1000;
    assert.ok(errorMs < 20, `rate ${rate}: wrote ${written} of ${totalOut}`);
    assert.equal(starved, 0, 'should not starve after end-of-input');
  }
});

test('render reports starvation when input is exhausted mid-stream', () => {
  const wsola = new Wsola({ sampleRate: SR, channels: 1 });
  wsola.setRate(0.5);
  wsola.push([tone(330, 0.05)], 0);
  const tmp = [new Float32Array(4096)];
  wsola.render(tmp);
  wsola.render(tmp);
  wsola.render(tmp);
  assert.ok(wsola.starvedFrames > 0, 'starvation must be counted, not hidden');
  assert.equal(wsola.underrun, true);
});

test('deterministic output for identical inputs', () => {
  const src = tone(523.25, 0.5);
  const a = Wsola.stretch([src], { sampleRate: SR, rate: 0.5 })[0];
  const b = Wsola.stretch([src], { sampleRate: SR, rate: 0.5 })[0];
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 97) assert.equal(a[i], b[i]);
});
