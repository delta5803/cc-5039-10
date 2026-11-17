import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSampleMedia, SAMPLE } from './genmedia.js';
import {
  decodeVideoFrames, readFrameNumber, meanBrightness,
  detectPulses, dominantFreq, decodeAudioMono,
} from './analyze.js';
import { renderClip } from '../core/engine.js';
import { probeMedia } from '../core/probe.js';
import { MIN_RATE, MAX_RATE } from '../core/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(__dirname, '..', 'data', 'test');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

function approx(name, actual, expected, tol) {
  check(name, Math.abs(actual - expected) <= tol,
    `(实际 ${actual.toFixed ? actual.toFixed(4) : actual}, 期望 ${expected}, 容差 ${tol})`);
}

async function main() {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });

  console.log('== 生成合成运动视频（帧号色块 + 移动块 + 同步闪光 + 脉冲/持续音） ==');
  const samplePath = path.join(WORK, 'sample.mp4');
  await generateSampleMedia(samplePath);
  const meta = await probeMedia(samplePath);
  console.log(`  源: ${meta.width}x${meta.height} @ ${meta.fps}fps, ${meta.durationSec.toFixed(3)}s, 音频 ${meta.sampleRate}Hz x${meta.channels}`);
  approx('源帧率', meta.fps, SAMPLE.fps, 0.01);
  approx('源时长', meta.durationSec, SAMPLE.durationSec, 0.1);

  // ---------- 速率扫描：端到端核对 ----------
  for (const rate of [1.0, 0.5, 0.25, 2.0]) {
    console.log(`\n== 速率 ${rate}x 全区间 [0, ${SAMPLE.durationSec}] ==`);
    const outPath = path.join(WORK, `out-${rate}.mp4`);
    const stats = await renderClip({
      inputPath: samplePath,
      outputPath: outPath,
      segments: [{ inSec: 0, outSec: SAMPLE.durationSec, rate }],
    });
    const expectDur = SAMPLE.durationSec / rate;

    approx('输出时长(视频流)', stats.outputDurationSec, expectDur, 1.5 / SAMPLE.fps);
    approx('输出时长(音频流)', stats.audio.outputDurationSec, expectDur, 0.15);
    check('采用速率与请求一致', stats.adoptedRates[0] === rate);
    approx('WSOLA 固定延迟已记录', stats.sync.compensatedFixedLatencySec,
      stats.audio.params.windowSamples / SAMPLE.sampleRate, 1e-6);
    check('音频抖动有界(<搜索半径)', stats.sync.audioJitterMaxAbsSec < 0.013,
      `max=${(stats.sync.audioJitterMaxAbsSec * 1000).toFixed(2)}ms`);
    check('实际解码速率已计量', stats.decode.avgDecodeFps > 0);
    check('缓冲水位随速率调整', stats.decode.highWaterFrames >= 8);
    check('缓冲未越水位太多', stats.decode.maxQueueSeen <= stats.decode.highWaterFrames + 8,
      `maxQueue=${stats.decode.maxQueueSeen} highWater=${stats.decode.highWaterFrames}`);

    // 视频：逐帧读回帧号，应等于 round(k*rate) ±1
    let frameErrMax = 0;
    let frames = 0;
    const flashTimes = [];
    await decodeVideoFrames(outPath, (buf, idx) => {
      const n = readFrameNumber(buf, meta.width);
      const expect = Math.round(idx * rate);
      frameErrMax = Math.max(frameErrMax, Math.abs(n - expect));
      frames++;
      if (meanBrightness(buf, meta.width, meta.height) > 180) {
        flashTimes.push(idx / SAMPLE.fps);
      }
    });
    approx('输出帧数', frames, Math.round(expectDur * SAMPLE.fps), 2);
    check(`帧号映射正确(最大误差 ${frameErrMax} 帧)`, frameErrMax <= 1);

    // 闪光帧聚成事件（连续亮点取中心时刻）
    const flashEvents = [];
    for (const t of flashTimes) {
      const last = flashEvents[flashEvents.length - 1];
      if (last && t - last.end <= 2.5 / SAMPLE.fps) {
        last.end = t;
      } else {
        flashEvents.push({ start: t, end: t });
      }
    }
    const flashCenters = flashEvents.map((e) => (e.start + e.end) / 2);

    // 音频：脉冲位置 = 源脉冲时刻 / rate。
    // WSOLA 会把 24ms 的瞬态脉冲按拉伸比抹宽（0.25x 时约 96ms），
    // 包络峰值的定位不确定度随之放大——这是算法固有特性，容差按 1/rate 缩放。
    const posTol = 0.05 + 0.03 / rate;
    const { mono } = await decodeAudioMono(outPath);
    const pulses = detectPulses(mono, SAMPLE.sampleRate);
    const expectPulses = SAMPLE.pulseTimes.map((t) => t / rate);
    check('脉冲数量一致', pulses.times.length === expectPulses.length,
      `检出 ${pulses.times.length} 个: [${pulses.times.map((t) => t.toFixed(2)).join(', ')}]`);
    let pulseErrMax = 0;
    for (let i = 0; i < Math.min(pulses.times.length, expectPulses.length); i++) {
      pulseErrMax = Math.max(pulseErrMax, Math.abs(pulses.times[i] - expectPulses[i]));
    }
    check(`脉冲位置对齐(最大误差 ${(pulseErrMax * 1000).toFixed(1)}ms, 容差 ${(posTol * 1000).toFixed(0)}ms)`,
      pulseErrMax < posTol);

    // 音画同步：每个检出脉冲应落在某个闪光事件中心附近（同一媒体时钟约束）
    let syncErrMax = 0;
    for (const pt of pulses.times) {
      let best = Infinity;
      for (const ft of flashCenters) best = Math.min(best, Math.abs(ft - pt));
      syncErrMax = Math.max(syncErrMax, best);
    }
    check(`音画事件对齐(最大偏差 ${(syncErrMax * 1000).toFixed(1)}ms)`, syncErrMax < posTol + 1.5 / SAMPLE.fps);

    // 音高：持续音主频仍为 440Hz
    const mid = Math.floor(mono.length / 2);
    const seg = mono.subarray(mid, mid + 16384);
    const f0 = dominantFreq(seg, SAMPLE.sampleRate, 300, 600);
    approx('持续音主频(音高保持)', f0, SAMPLE.toneFreq, 6);
  }

  // ---------- 分段变速：速率切换时缓冲与连续性 ----------
  console.log('\n== 分段变速 [0,2]@1.0x + [2,4]@0.5x ==');
  {
    const outPath = path.join(WORK, 'out-seg.mp4');
    const stats = await renderClip({
      inputPath: samplePath,
      outputPath: outPath,
      segments: [
        { inSec: 0, outSec: 2, rate: 1.0 },
        { inSec: 2, outSec: 4, rate: 0.5 },
      ],
    });
    approx('分段输出时长', stats.outputDurationSec, 2 / 1.0 + 2 / 0.5, 0.1);
    let prev = -1;
    let jumpMax = 0;
    let frames = 0;
    await decodeVideoFrames(outPath, (buf) => {
      const n = readFrameNumber(buf, meta.width);
      if (prev >= 0) jumpMax = Math.max(jumpMax, Math.abs(n - prev));
      prev = n;
      frames++;
    });
    approx('分段输出帧数', frames, 180, 2);
    check(`帧号连续无跳变(最大相邻差 ${jumpMax})`, jumpMax <= 2);
    check('分段速率全部按请求采用',
      stats.adoptedRates[0] === 1.0 && stats.adoptedRates[1] === 0.5);
  }

  // ---------- 超限拒绝 ----------
  console.log('\n== 超限拒绝 ==');
  for (const bad of [MIN_RATE - 0.01, MAX_RATE + 0.01, 0, -1, NaN]) {
    let rejected = false;
    try {
      await renderClip({
        inputPath: samplePath,
        outputPath: path.join(WORK, 'never.mp4'),
        segments: [{ inSec: 0, outSec: 1, rate: bad }],
      });
    } catch (err) {
      rejected = err.name === 'ValidationError';
    }
    check(`速率 ${String(bad)} 被拒绝`, rejected);
  }
  {
    let rejected = false;
    try {
      await renderClip({
        inputPath: samplePath,
        outputPath: path.join(WORK, 'never.mp4'),
        segments: [{ inSec: 3, outSec: 99, rate: 1 }],
      });
    } catch (err) {
      rejected = err.name === 'ValidationError';
    }
    check('超出片长的区间被拒绝', rejected);
  }

  console.log(`\n== 结果: ${passed} 通过, ${failed} 失败 ==`);
  if (failed > 0) {
    console.log('失败项:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('测试运行异常:', err);
  process.exit(1);
});
