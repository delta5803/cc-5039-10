import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { SAMPLE } from './genmedia.js';
import { decodeAudio } from '../core/decoder.js';
import { probeMedia } from '../core/probe.js';

// 逐帧解码视频，回调每帧 RGB 缓冲
export async function decodeVideoFrames(filePath, onFrame) {
  const meta = await probeMedia(filePath);
  const frameBytes = meta.width * meta.height * 3;
  const proc = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', filePath,
    '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let acc = Buffer.alloc(0);
  let idx = 0;
  proc.stdout.on('data', (chunk) => {
    acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
    while (acc.length >= frameBytes) {
      const frame = acc.subarray(0, frameBytes);
      acc = acc.subarray(frameBytes);
      onFrame(Buffer.from(frame), idx++, meta);
    }
  });
  await new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`视频解码退出码 ${code}`))));
  });
  return { frameCount: idx, meta };
}

// 从画面读出帧号（二进制色块）
export function readFrameNumber(rgbBuf, width) {
  const { counter } = SAMPLE;
  let n = 0;
  for (let b = 0; b < counter.bits; b++) {
    const x = counter.x0 + b * counter.pitch + counter.cell / 2;
    const y = counter.y0 + counter.cell / 2;
    const v = rgbBuf[(y * width + x) * 3];
    if (v > 128) n |= 1 << b;
  }
  return n;
}

// 中央区域平均亮度（避开帧号色块与红块），用于检测同步闪光帧
export function meanBrightness(rgbBuf, width, height) {
  let sum = 0, cnt = 0;
  for (let y = 60; y < 120; y += 4) {
    for (let x = 40; x < width - 40; x += 4) {
      sum += rgbBuf[(y * width + x) * 3];
      cnt++;
    }
  }
  return sum / cnt;
}

// 包络峰值检测：整流 + 滑动平均，阈值取中位数的倍数
export function detectPulses(mono, sampleRate, { windowMs = 2, thresholdRatio = 4, minDistSec = 0.1, minAbs = 0.015 } = {}) {
  const w = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const env = new Float64Array(mono.length);
  let run = 0;
  for (let i = 0; i < mono.length; i++) {
    run += Math.abs(mono[i]);
    if (i >= w) run -= Math.abs(mono[i - w]);
    env[i] = run / w;
  }
  const sorted = Array.from(env).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const threshold = Math.max(minAbs, median * thresholdRatio);
  const minDist = Math.round(minDistSec * sampleRate);
  const times = [];
  let i = 0;
  while (i < env.length) {
    if (env[i] > threshold) {
      let peak = i;
      const end = Math.min(env.length, i + minDist);
      for (let j = i + 1; j < end; j++) if (env[j] > env[peak]) peak = j;
      times.push(peak / sampleRate);
      i = peak + minDist;
    } else {
      i++;
    }
  }
  return { times, threshold, median };
}

// 基-2 FFT，返回幅值谱（前半）
export function fftMagnitude(samples) {
  const n = samples.length;
  const re = Float64Array.from(samples);
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * cwr - im[i + j + len / 2] * cwi;
        const vi = re[i + j + len / 2] * cwi + im[i + j + len / 2] * cwr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

// 主频估计：加窗 FFT 后在 [fMin, fMax] 内找谱峰
export function dominantFreq(samples, sampleRate, fMin = 100, fMax = 2000) {
  let n = 1;
  while (n * 2 <= samples.length) n <<= 1;
  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    windowed[i] = samples[i] * w;
  }
  const mag = fftMagnitude(windowed);
  const binHz = sampleRate / n;
  let best = -1, bestMag = 0;
  for (let f = Math.ceil(fMin / binHz); f <= Math.min(Math.floor(fMax / binHz), mag.length - 1); f++) {
    if (mag[f] > bestMag) { bestMag = mag[f]; best = f; }
  }
  return best * binHz;
}

export async function decodeAudioMono(filePath, sampleRate = 44100) {
  const meta = await probeMedia(filePath);
  const { channels } = await decodeAudio(filePath, {
    startSec: 0,
    durationSec: meta.durationSec + 1,
    sampleRate,
    channels: 1,
  });
  return { mono: channels[0], sampleRate };
}
