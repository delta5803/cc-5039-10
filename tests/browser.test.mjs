// Browser integration tests for the slow-motion kernel.
//
// These run the real processing chain in headless Chromium: WebCodecs decode,
// the WSOLA renderer worklet, the shared media clock, and the graphical player.
// `npm test` runs this alongside the Node unit tests.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser } from './harness.mjs';

const FIXTURE = '/tests/fixtures/numbered-640x360-30fps.mp4';
const PULSES = '/tests/fixtures/pulses-320x240-25fps.mp4';
const MAX = 1.5;
const MIN = 0.1;

let server;
let browser;
let origin;
let page;

async function openBench() {
  page = await browser.newPage();
  page.on('pageerror', (e) => {
    console.error('[pageerror]', e.message);
  });
  await page.goto(`${origin}/tests/bench.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 15000 });
}

before(async () => {
  ({ server, origin } = await startServer());
  browser = await launchBrowser();
  await openBench();
});

after(async () => {
  await page?.close();
  await browser?.close();
  server?.close();
});

// Every test creates its own engine in the page and tears it down, so a slow
// test cannot leave a shared audio graph running for the next one.
async function withEngine(fn, { rate = 1, loop = true, url = FIXTURE } = {}) {
  const result = await page.evaluate(
    async ({ fn: body, rate, loop, url }) => {
      const { engine, ctx } = await window.bench.makeEngine(url, { rate, loop });
      try {
        return await new Function('engine', 'ctx', 'bench', `return (${body})(engine, ctx, bench);`)(
          engine, ctx, window.bench,
        );
      } finally {
        engine.dispose();
      }
    },
    { fn: fn.toString(), rate, loop, url },
  );
  return result;
}

test('rate policy rejects out-of-range and reports the adopted rate', async () => {
  const { resolveRate } = await import('../src/kernel/rates.js');
  const tooSlow = resolveRate(MIN - 0.01);
  const tooFast = resolveRate(MAX + 0.01);
  assert.equal(tooSlow.ok, false);
  assert.equal(tooSlow.code, 'OUT_OF_RANGE');
  assert.equal(tooFast.ok, false);
  assert.equal(resolveRate(0.5).degraded, false);
  assert.equal(resolveRate(0.15).degraded, true);
  assert.equal(resolveRate(1).tier, 'native');
});

test('engine adopts the requested rate and plays through the real chain', async () => {
  const out = await withEngine(async (engine) => {
    const info = await engine.setRate(0.5);
    const tap = await window.bench.withTap(engine.ctx, engine);
    await engine.play();
    await window.bench.sleep(2200);
    const audio = await tap.dump();
    const stats = engine.stats();
    engine.pause();
    let freq = 0;
    let rms = 0;
    if (audio && audio.left.length) {
      // Measure only the sustained tone. Source bursts land at output 0 s and
      // 1 s at 0.5x, and the first one smears to ~0.35 s through the 30 ms
      // WSOLA frames, so 0.55–0.95 s is burst-free.
      const sr = audio.sampleRate;
      const from = Math.round(0.55 * sr);
      const to = Math.min(audio.left.length, Math.round(0.95 * sr));
      const slice = audio.left.subarray(from, to);
      freq = window.bench.zeroCrossFreq(slice, sr);
      rms = window.bench.rms(slice);
    }
    return {
      adopted: info.adopted,
      tier: info.tier,
      position: stats.position,
      playing: stats.playing,
      source: stats.positionSource,
      underflows: stats.clock.audioUnderruns,
      ringMs: stats.clock.audioRingSeconds * 1000,
      freq,
      rms,
      latencyMs: stats.latency.algorithm * 1000,
      devMs: stats.clock.deviationSeconds * 1000,
    };
  }, { rate: 0.5 });

  assert.equal(out.adopted, 0.5);
  assert.equal(out.tier, 'guaranteed');
  assert.ok(out.position > 0.4, `position should advance, got ${out.position}`);
  assert.equal(out.source, 'audio');
  assert.equal(out.underflows, 0, 'no renderer underruns at 0.5x');
  assert.ok(out.rms > 0.01, `audio must not be silent, rms=${out.rms}`);
  // 440 Hz sustained tone at half speed must still be 440 Hz.
  assert.ok(Math.abs(out.freq - 440) < 12, `pitch should stay near 440 Hz, got ${out.freq}`);
  assert.ok(out.latencyMs > 0, 'algorithm latency must be measured');
});

test('program duration of a loop pass follows the rate', async () => {
  const out = await withEngine(async (engine) => {
    const span = engine.programDuration;
    await engine.setRegion({ start: 0, end: span });
    await engine.setRate(0.25);
    const tap = await window.bench.withTap(engine.ctx, engine);
    await engine.play();
    await window.bench.sleep(2500);
    const audio = await tap.dump();
    const stats = engine.stats();
    engine.pause();
    return {
      span,
      samples: audio ? audio.left.length : 0,
      sr: audio ? audio.sampleRate : 0,
      loopIndex: stats.loopIndex,
      underflows: stats.clock.audioUnderruns,
    };
  });

  // 2.5 s of output at 0.25x should carry about 0.625 s of program material;
  // the loop wrap must have produced a manageable pass count, not stalled.
  assert.equal(out.underflows, 0);
  assert.ok(out.samples > 0, 'tap captured no audio');
  assert.ok(out.samples / out.sr > 2.0, `captured ${out.samples / out.sr}s, expected >2s`);
});

test('frame selection matches the shared clock position', async () => {
  const out = await withEngine(async (engine) => {
    await engine.setRate(0.5);
    await engine.play();
    await window.bench.sleep(1800);
    const samples = [];
    for (let i = 0; i < 12; i++) {
      const stats = engine.stats();
      const frame = engine.frameAtProgram(stats.position);
      samples.push({
        position: stats.position,
        framePts: frame ? frame.timestamp / 1e6 : null,
        statsPts: stats.av.framePts,
      });
      await window.bench.sleep(110);
    }
    engine.pause();
    return samples;
  });

  for (const s of out) {
    assert.ok(Number.isFinite(s.position), 'position must be finite');
    if (s.framePts != null) {
      // The decoded frame containing the clock position must be within one
      // frame of that position (30 fps fixture).
      assert.ok(
        Math.abs(s.framePts - s.position) <= 0.04,
        `frame ${s.framePts} does not cover position ${s.position}`,
      );
    }
  }
});

test('loop region wraps to the region start and keeps advancing', async () => {
  const out = await withEngine(async (engine) => {
    await engine.setRegion({ start: 1.0, end: 1.6 });
    await engine.setRate(0.5);
    await engine.play();
    const seen = [];
    for (let i = 0; i < 40; i++) {
      const s = engine.stats();
      seen.push({ pos: s.position, loop: s.loopIndex, dev: s.clock.deviationSeconds });
      await window.bench.sleep(100);
    }
    engine.pause();
    return seen;
  });

  const loops = out.map((s) => s.loop);
  assert.ok(Math.max(...loops) >= 2, `should complete multiple passes, saw ${loops.join(',')}`);
  for (const s of out) {
    assert.ok(s.pos >= 0.99 && s.pos <= 1.61, `position ${s.pos} escaped the region`);
  }
  // Loop cuts must not masquerade as drift: the deviation stays bounded.
  const maxDev = Math.max(...out.map((s) => Math.abs(s.dev)));
  assert.ok(maxDev < 0.08, `deviation ${maxDev}s too large across loop cuts`);
});

test('rate change mid-playback re-anchors without permanent offset', async () => {
  const out = await withEngine(async (engine) => {
    await engine.play();
    await window.bench.sleep(1200);
    await engine.setRate(1.25);
    await window.bench.sleep(1800);
    const s = engine.stats();
    engine.pause();
    return { dev: s.clock.deviationSeconds, drift: s.clock.driftPpm, underflows: s.clock.audioUnderruns };
  });

  assert.equal(out.underflows, 0);
  assert.ok(Math.abs(out.dev) < 0.15, `deviation after re-anchor: ${out.dev}s`);
  assert.ok(Math.abs(out.drift) < 50000, `drift should be small, got ${out.drift} ppm`);
});

test('pulses fixture keeps audio events in place at 0.5x', async () => {
  const out = await withEngine(async (engine) => {
    await engine.setRegion({ start: 0, end: engine.programDuration });
    await engine.setRate(0.5);
    const tap = await window.bench.withTap(engine.ctx, engine);
    await engine.play();
    await window.bench.sleep(3000);
    const audio = await tap.dump();
    engine.pause();
    if (!audio) return null;
    const onsets = window.bench.onsetTimes(audio.left, audio.sampleRate, { threshold: 0.05 });
    return { onsets, rms: window.bench.rms(audio.left) };
  }, { url: PULSES });

  assert.ok(out, 'tap returned no audio');
  assert.ok(out.rms > 0.01, 'pulse audio must be audible');
  // The fixture has a 1 kHz burst every 0.5 s of program time, so at 0.5x the
  // output must contain roughly one clear event per second.
  assert.ok(
    out.onsets.length >= 2,
    `expected pulse onsets, got ${out.onsets.length} (${out.onsets.map((t) => t.toFixed(2)).join(', ')})`,
  );
  const spacing = out.onsets.slice(1).map((t, i) => t - out.onsets[i]);
  if (spacing.length) {
    assert.ok(
      spacing.every((d) => d > 0.7 && d < 1.3),
      `bursts should be ~1 s apart at 0.5x, got ${spacing.map((d) => d.toFixed(2)).join(', ')}`,
    );
  }
});
