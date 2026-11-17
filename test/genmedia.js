import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

// 合成“自制运动视频”：画面内容逐帧可机读，用于自动化核对。
//  - 左上角 16 个 8x8 色块 = 帧号的二进制位（bit0 在最左）
//  - 背景灰度随帧号变化；脉冲时刻附近整帧提亮（音画同步的视觉事件）
//  - 红色方块匀速移动（运动参照）
// 音频：440Hz 持续音（音高核对）+ 每 0.5s 一个 2kHz 短脉冲（位置核对）。

export const SAMPLE = {
  width: 320,
  height: 180,
  fps: 30,
  durationSec: 4.0,
  sampleRate: 44100,
  channels: 2,
  toneFreq: 440,
  toneAmp: 0.08,
  pulseFreq: 2000,
  pulseAmp: 0.9,
  pulseHalfWidthSec: 0.012,
  pulseTimes: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5],
  counter: { x0: 4, y0: 4, bits: 16, cell: 8, pitch: 10 },
};

function isFlashFrame(n, fps) {
  for (const p of SAMPLE.pulseTimes) {
    if (Math.abs(n - p * fps) <= 1.5) return true;
  }
  return false;
}

export function makeFrame(n) {
  const { width: W, height: H, fps, counter } = SAMPLE;
  const buf = Buffer.alloc(W * H * 3);
  const bg = isFlashFrame(n, fps) ? 235 : 60 + (n % 90);
  for (let i = 0; i < W * H; i++) {
    buf[i * 3] = bg; buf[i * 3 + 1] = bg; buf[i * 3 + 2] = bg;
  }
  // 帧号色块
  for (let b = 0; b < counter.bits; b++) {
    const v = (n >> b) & 1 ? 255 : 0;
    const x0 = counter.x0 + b * counter.pitch;
    for (let y = counter.y0; y < counter.y0 + counter.cell; y++) {
      for (let x = x0; x < x0 + counter.cell; x++) {
        const o = (y * W + x) * 3;
        buf[o] = v; buf[o + 1] = v; buf[o + 2] = v;
      }
    }
  }
  // 移动红块
  const bx = (n * 4) % (W - 16);
  const by = H - 40;
  for (let y = by; y < by + 16; y++) {
    for (let x = bx; x < bx + 16; x++) {
      const o = (y * W + x) * 3;
      buf[o] = 200; buf[o + 1] = 30; buf[o + 2] = 30;
    }
  }
  return buf;
}

export function makeAudio() {
  const { sampleRate: sr, durationSec, channels, toneFreq, toneAmp, pulseFreq, pulseAmp, pulseHalfWidthSec, pulseTimes } = SAMPLE;
  const N = Math.round(durationSec * sr);
  const buf = Buffer.alloc(N * channels * 4);
  for (let i = 0; i < N; i++) {
    const t = i / sr;
    let s = toneAmp * Math.sin(2 * Math.PI * toneFreq * t);
    for (const p of pulseTimes) {
      if (Math.abs(t - p) <= pulseHalfWidthSec) {
        s += pulseAmp * Math.sin(2 * Math.PI * pulseFreq * t);
      }
    }
    s = Math.max(-1, Math.min(1, s));
    for (let c = 0; c < channels; c++) buf.writeFloatLE(s, (i * channels + c) * 4);
  }
  return buf;
}

export async function generateSampleMedia(outPath) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'slowmo-gen-'));
  try {
    const audioPath = path.join(tmp, 'audio.pcm');
    await writeFile(audioPath, makeAudio());
    const { width: W, height: H, fps, durationSec } = SAMPLE;
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(fps),
      '-i', 'pipe:0',
      '-f', 'f32le', '-ar', String(SAMPLE.sampleRate), '-ac', String(SAMPLE.channels),
      '-i', audioPath,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '160k',
      '-shortest', outPath,
    ];
    const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    const done = new Promise((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`生成样本失败: ${stderr.slice(-500)}`))));
    });
    const total = Math.round(durationSec * fps);
    for (let n = 0; n < total; n++) {
      if (!proc.stdin.write(makeFrame(n))) {
        await new Promise((r) => proc.stdin.once('drain', r));
      }
    }
    proc.stdin.end();
    await done;
    return outPath;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
