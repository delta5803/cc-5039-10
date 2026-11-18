// Generates the controlled test clips used by the test suite.
//
// Every frame is visually numbered, so a decoded frame identifies its exact
// source index. Audio is a sustained 440 Hz tone with short 1 kHz bursts on a
// known schedule plus a louder sync tick on every second boundary, so tests can
// measure pitch through the stretcher and locate program positions in output.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ffmpegPath = (await import('@ffmpeg-installer/ffmpeg')).default.path;

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_MONO = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf';

export const FIXTURES = {
  numbered: {
    file: 'numbered-640x360-30fps.mp4',
    width: 640,
    height: 360,
    fps: 30,
    duration: 4,
    toneHz: 440,
  },
  pulses: {
    file: 'pulses-320x240-25fps.mp4',
    width: 320,
    height: 240,
    fps: 25,
    duration: 4,
    toneHz: 440,
  },
};

export function fixturePath(name) {
  return path.join('tests', 'fixtures', FIXTURES[name].file);
}

function buildVideoFilter(spec) {
  const { width, height } = spec;
  const fontSize = Math.round(height * 0.33);
  const labelSize = Math.round(height * 0.067);
  const markSize = Math.max(16, Math.round(height * 0.08));
  const travel = width - markSize;
  const step = Math.max(1, Math.round(travel / 60));
  return [
    `drawtext=fontfile=${FONT}:text='█':fontcolor=0x2f80ed:fontsize=${markSize}:x='mod(n*${step}\\,${travel})':y=${Math.round(height * 0.02)}`,
    `drawtext=fontfile=${FONT_MONO}:text='%{n}':fontcolor=white:fontsize=${fontSize}:x=(w-tw)/2:y=(h-th)/2`,
    `drawtext=fontfile=${FONT}:text='FRAME %{n}  %{pts\\:hms}':fontcolor=0xffc857:fontsize=${labelSize}:x=(w-tw)/2:y=h-th-${Math.round(height * 0.045)}`,
    `drawbox=x=0:y=h-${Math.max(4, Math.round(height * 0.017))}:w=iw:h=${Math.max(4, Math.round(height * 0.017))}:color=0x2f80ed:t=fill`,
  ].join(',');
}

// Audio: sustained tone (pitch probe) plus short position bursts. Generating
// the waveform sample-exactly in Node gives the tests ground-truth times
// instead of relying on filter-graph timing.
//
//  - 440 Hz tone at constant amplitude (pitch reference)
//  - every 0.5 s: 1000 Hz burst, 60 ms
//  - every whole second: 1500 Hz burst, 120 ms (coarse anchor)
export function buildAudioWav(spec, sampleRate = 48000) {
  const n = Math.round(spec.duration * sampleRate);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const toneAmp = 0.25;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    L[i] = toneAmp * Math.sin(2 * Math.PI * spec.toneHz * t);
    R[i] = toneAmp * Math.sin(2 * Math.PI * spec.toneHz * t + 0.7);
  }
  const bursts = [];
  for (let t = 0; t < spec.duration; t += 0.5) {
    const whole = Math.abs(t - Math.round(t)) < 1e-6;
    const freq = whole ? 1500 : 1000;
    const len = whole ? 0.12 : 0.06;
    const amp = 0.55;
    const s0 = Math.round(t * sampleRate);
    const s1 = Math.min(n, Math.round((t + len) * sampleRate));
    // 5 ms raised-cosine edges so the burst has no click.
    const edge = Math.round(0.005 * sampleRate);
    for (let i = s0; i < s1; i++) {
      const k = i - s0;
      const env = Math.min(1, k / edge, (s1 - i) / edge);
      const v = amp * env * Math.sin(2 * Math.PI * freq * (i - s0) / sampleRate);
      L[i] += v;
      R[i] += v;
    }
    bursts.push({ start: s0 / sampleRate, end: s1 / sampleRate, freq, amp });
  }
  return { sampleRate, channels: 2, left: L, right: R, bursts };
}

function writeWav(file, { sampleRate, left, right }) {
  const n = left.length;
  const channels = 2;
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
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (const ch of [left, right]) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      buf.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  }
  fs.writeFileSync(file, buf);
}

export function generateFixtures({ force = false } = {}) {
  fs.mkdirSync(path.join('tests', 'fixtures'), { recursive: true });
  for (const [name, spec] of Object.entries(FIXTURES)) {
    const out = fixturePath(name);
    if (!force && fs.existsSync(out) && fs.statSync(out).size > 0) continue;
    const wav = path.join('tests', 'fixtures', `${name}.wav`);
    const audio = buildAudioWav(spec);
    writeWav(wav, audio);
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi',
      '-i', `color=c=0x101418:s=${spec.width}x${spec.height}:r=${spec.fps}:d=${spec.duration}`,
      '-i', wav,
      '-vf', buildVideoFilter(spec),
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-bf', '0',
      '-g', String(spec.fps),
      '-keyint_min', String(spec.fps),
      '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-ac', '2',
      '-t', String(spec.duration),
      '-movflags', '+faststart',
      out,
    ];
    execFileSync(ffmpegPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    fs.unlinkSync(wav);
    const size = fs.statSync(out).size;
    if (size === 0) throw new Error(`fixture ${name} is empty`);
    fs.writeFileSync(
      path.join('tests', 'fixtures', `${name}.meta.json`),
      JSON.stringify(
        { spec, sampleRate: audio.sampleRate, bursts: audio.bursts },
        null,
        2,
      ),
    );
    console.log(`generated ${out} (${(size / 1024).toFixed(0)} KiB)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateFixtures({ force: process.argv.includes('--force') });
}
