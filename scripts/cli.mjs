#!/usr/bin/env node
// Auxiliary command line for the slow-motion kernel.
//
// The graphical player (see README) is the primary interface. This tool drives
// the same offline path through the same WSOLA implementation so a batch of
// clips can be checked without a browser window:
//
//   node scripts/cli.mjs <input.mp4> [--rate 0.5] [--from 0] [--to 2]
//                        [--out stretched.wav] [--json]
//
// It runs inside headless Chromium because WebCodecs decoding and the kernel
// are browser APIs; the measurement itself is the real processing chain, not a
// separate reimplementation.

import path from 'node:path';
import fs from 'node:fs';
import { startServer, launchBrowser } from '../tests/harness.mjs';

function parseArgs(argv) {
  const args = { rate: 1, from: 0, to: null, out: null, json: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rate') args.rate = Number(argv[++i]);
    else if (a === '--from') args.from = Number(argv[++i]);
    else if (a === '--to') args.to = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!a.startsWith('-') && !args.file) args.file = a;
  }
  return args;
}

function usage() {
  console.log(`动作慢放命令行（辅助工具，主入口为图形播放器）

用法:
  node scripts/cli.mjs <input.mp4> [选项]

选项:
  --rate <倍数>   时间伸缩倍数，支持 0.10–1.50（默认 1）
  --from <秒>     区间起点（默认 0）
  --to <秒>       区间终点（默认片段长度）
  --out <文件>    将伸缩后的音频写成 16 位 WAV
  --json          输出机器可读结果
  -h, --help      显示本帮助

示例:
  node scripts/cli.mjs tests/fixtures/numbered-640x360-30fps.mp4 --rate 0.5 --from 1 --to 3 --out slow.wav
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.file) {
  usage();
  process.exit(args.help ? 0 : 1);
}

const abs = path.resolve(args.file);
if (!fs.existsSync(abs)) {
  console.error(`找不到文件: ${abs}`);
  process.exit(1);
}

const { server, origin } = await startServer();
const browser = await launchBrowser();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`${origin}/tests/bench.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 15000 });

const fileName = path.basename(abs);
// Expose the file to the page under a URL the static server can serve. The
// harness serves the repo root, so a file outside it is streamed through a
// blob instead.
const buffer = fs.readFileSync(abs);
const dataB64 = buffer.toString('base64');

const result = await page.evaluate(
  async ({ dataB64, fileName, rate, from, to }) => {
    const bin = atob(dataB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    const engine = new window.bench.SlowmoEngine({ audioContext: ctx });
    // The engine owns the context and closes it on dispose; closing it here as
    // well would throw.
    try {
      await engine.load(bytes.buffer, { loop: false });
      const info = engine.info();
      const rateInfo = await engine.setRate(rate);
      if (!rateInfo.ok) {
        return { error: rateInfo.message, rejected: true, rate: rateInfo };
      }
      const end = Math.min(to ?? info.duration, info.duration);
      const start = Math.max(0, Math.min(from, end - 0.001));
      const segment = await engine.renderProgramSegment(start, end, { rate: rateInfo.adopted });
      const left = segment.planar[0];
      const right = segment.planar[1] ?? left;

      // Pitch on a mid segment, away from edge fades and the fixture's burst.
      const sr = segment.sampleRate;
      const toneFrom = Math.round(Math.min(left.length * 0.5, 0.55 * sr));
      const toneTo = Math.round(Math.min(left.length, toneFrom + 0.35 * sr));
      const tone = left.subarray(toneFrom, toneTo);
      const freq = tone.length > 2048 ? window.bench.zeroCrossFreq(tone, sr) : 0;
      const rms = left.length ? window.bench.rms(left) : 0;

      return {
        fileName,
        duration: info.duration,
        from: start,
        to: end,
        requested: rateInfo.requested,
        adopted: rateInfo.adopted,
        tier: rateInfo.tier,
        degraded: rateInfo.degraded,
        sampleRate: sr,
        channels: segment.channels,
        expectedSamples: segment.expected,
        writtenSamples: segment.written,
        outputSeconds: segment.written / sr,
        expectedSeconds: (end - start) / rateInfo.adopted,
        pitchHz: freq,
        rms,
        left: Array.from(left.subarray(0, Math.min(left.length, sr * 60))),
        right: Array.from(right.subarray(0, Math.min(right.length, sr * 60))),
        truncated: left.length > sr * 60,
      };
    } finally {
      engine.dispose();
    }
  },
  { dataB64, fileName, rate: args.rate, from: args.from, to: args.to },
);

await browser.close();
server.close();

if (result.error) {
  console.error(result.error);
  process.exit(2);
}

const wavOut = args.out ? path.resolve(args.out) : null;
if (wavOut) {
  // Only the first 60 s of PCM is returned from the page; enough for spot
  // checks and keeps the bridge small.
  const left = Float32Array.from(result.left);
  const right = Float32Array.from(result.right);
  writeWav(wavOut, left, right, result.sampleRate);
}

if (args.json) {
  const { left, right, ...meta } = result;
  console.log(JSON.stringify({ ...meta, wav: wavOut, truncated: result.truncated }, null, 2));
} else {
  console.log(`文件: ${result.fileName}`);
  console.log(`区间: ${result.from.toFixed(3)} s → ${result.to.toFixed(3)} s`);
  console.log(`速率: 请求 ${result.requested}×，采用 ${result.adopted}×（${result.tier}${result.degraded ? '，音质降级' : ''}）`);
  console.log(`输出: ${result.outputSeconds.toFixed(3)} s（期望 ${result.expectedSeconds.toFixed(3)} s）`);
  console.log(`采样: ${result.writtenSamples} / ${result.expectedSamples} @ ${result.sampleRate} Hz, ${result.channels} ch`);
  console.log(`音高: ${result.pitchHz.toFixed(1)} Hz   电平: ${(20 * Math.log10(Math.max(result.rms, 1e-6))).toFixed(1)} dBFS`);
  if (wavOut) console.log(`WAV: ${wavOut}${result.truncated ? '（仅前 60 s）' : ''}`);
}

function writeWav(file, left, right, sampleRate) {
  const channels = 2;
  const n = Math.min(left.length, right.length);
  const bytesPerSample = 2;
  const dataLen = n * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}
