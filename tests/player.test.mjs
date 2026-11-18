// Graphical player tests: the buttons must drive the real engine, and the
// results panel must show live values rather than fixed placeholder data.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser } from './harness.mjs';

let server;
let browser;
let origin;
let page;

const text = (sel) => page.locator(sel).innerText();

before(async () => {
  ({ server, origin } = await startServer());
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`${origin}/src/player/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => document.getElementById('status')?.textContent.includes('就绪'),
    null,
    { timeout: 20000 },
  );
});

after(async () => {
  await page?.close();
  await browser?.close();
  server?.close();
});

test('demo clips come from the server, not baked-in UI data', async () => {
  assert.equal(await page.locator('#demo-row button').count(), 2);
  const media = await text('#media-info');
  assert.match(media, /640×360/);
  assert.match(media, /120 帧/);
  assert.match(media, /48000 Hz/);
});

test('play button runs the real engine and advances the reported position', async () => {
  const before = await text('#out-position-2');
  assert.equal(await text('#out-source'), '定位');
  await page.click('#play-btn');
  await page.waitForTimeout(1600);
  const after = await text('#out-position-2');
  assert.notEqual(after, before, 'position must advance while playing');
  assert.equal(await text('#out-source'), '音频渲染器输出');
  assert.equal(await text('#out-underruns'), '0');
  assert.match(await text('#out-loop'), /循环中/);
  await page.click('#play-btn');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#play-btn').innerText(), '播放');
});

test('speed presets change the adopted rate and the tier label', async () => {
  await page.click('#rate-presets button[data-rate="0.25"]');
  await page.waitForTimeout(700);
  assert.equal((await text('#out-adopted')).trim(), '0.25×');
  assert.equal(await text('#out-requested'), '0.25×');
  assert.equal(await text('#out-tier'), '音质保证区');
  assert.equal(await page.locator('#rate-notice').isHidden(), true);

  await page.click('#rate-presets button[data-rate="0.5"]');
  await page.waitForTimeout(700);
  assert.equal((await text('#out-adopted')).trim(), '0.50×');

  // Degraded tier below the quality window: the slider bottoms out at 0.1.
  await page.evaluate(() => {
    const slider = document.getElementById('rate-slider');
    slider.value = '0.1';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(700);
  assert.equal((await text('#out-adopted')).trim(), '0.10×（降级）');
  assert.equal(await text('#out-tier'), '音质降级');
  assert.equal(await page.locator('#rate-notice').isVisible(), true);
});

test('out-of-range rate is rejected and the previous rate stays adopted', async () => {
  await page.evaluate(() => {
    window.prompt = () => '3';
    document.getElementById('rate-value').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  assert.match(await text('#rate-notice'), /超出支持范围/);
  assert.match(await text('#rate-notice'), /已拒绝/);
  assert.equal((await text('#out-adopted')).trim(), '0.10×（降级）');
  assert.equal(await text('#out-tier'), '音质降级');
});

test('both rate directions work through the audio chain', async () => {
  await page.click('#rate-presets button[data-rate="0.75"]');
  await page.evaluate(() => {
    const slider = document.getElementById('rate-slider');
    slider.value = '1.25';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#play-btn');
  await page.waitForTimeout(1800);
  assert.equal((await text('#out-adopted')).trim(), '1.25×');
  assert.equal((await text('#out-underruns')), '0');
  const ring = Number((await text('#out-ring')).replace(' ms', ''));
  assert.ok(ring > 20, `audio ring should be primed, got ${ring} ms`);
  await page.click('#play-btn');
});

test('timeline drag selects a region that the engine loops', async () => {
  const box = await page.locator('#timeline').boundingBox();
  // Drag from 25% to 45% of the 4 s fixture.
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  assert.equal(await page.locator('#in-point').inputValue(), '1.000');
  assert.equal(await page.locator('#out-point').inputValue(), '1.800');
  assert.match(await text('#out-region'), /0:01\.000 → 0:01\.800/);

  await page.click('#play-btn');
  await page.waitForTimeout(2600);
  const loopText = await text('#out-loop');
  assert.match(loopText, /循环中 · 第 [2-9]\d* 遍/);
  const pos = await text('#out-position-2');
  const seconds = Number(pos.split(':')[1]);
  assert.ok(seconds >= 1 && seconds <= 1.81, `position ${pos} escaped the loop region`);
  await page.click('#play-btn');
});

test('region can be edited from the numeric inputs', async () => {
  await page.fill('#out-point', '3.000');
  await page.locator('#out-point').blur();
  await page.waitForTimeout(400);
  assert.match(await text('#out-region'), /0:01\.000 → 0:03\.000/);
  await page.fill('#in-point', '2.000');
  await page.locator('#in-point').press('Enter');
  await page.locator('#in-point').blur();
  await page.waitForTimeout(400);
  assert.match(await text('#out-region'), /0:02\.000 → 0:03\.000/);

  // An in-point past the out-point clamps instead of inverting the region.
  await page.fill('#in-point', '3.500');
  await page.locator('#in-point').blur();
  await page.waitForTimeout(400);
  assert.match(await text('#out-region'), /0:02\.950 → 0:03\.000/);
});

test('frame badge and current-frame readout agree with the clock', async () => {
  await page.click('#play-btn');
  await page.waitForTimeout(1200);
  const badge = await text('#frame-badge');
  assert.match(badge, /源位置 \d+\.\d{3} s/);
  const frameText = await text('#out-frame');
  const m = frameText.match(/^(\d+) \/ (\d+)/);
  assert.ok(m, `unexpected frame readout: ${frameText}`);
  assert.equal(m[2], '120');
  const shown = Number(m[1]);
  assert.ok(shown >= 0 && shown < 120, `frame index out of range: ${shown}`);
  const canvasBlank = await page.evaluate(() => {
    const c = document.getElementById('frame-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] || d[i + 1] || d[i + 2]) return false;
    return true;
  });
  assert.equal(canvasBlank, false, 'canvas must show decoded video, not a blank frame');
  await page.click('#play-btn');
});

test('audio meter shows non-silent output while playing', async () => {
  await page.click('#play-btn');
  await page.waitForTimeout(1500);
  // Probe the meter canvas for a drawn waveform (the meter renders the real
  // AnalyserNode tap of the AudioContext output, not a synthetic animation).
  const pixels = await page.evaluate(() => {
    const c = document.getElementById('audio-meter');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let bright = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 70 && d[i + 2] > 100) bright++;
    }
    return bright;
  });
  assert.ok(pixels > 50, `meter should draw a live waveform, saw ${pixels} pixels`);
  await page.click('#play-btn');
});
