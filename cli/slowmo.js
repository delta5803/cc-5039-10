#!/usr/bin/env node
// 辅助命令行：图形播放器（npm start）之外的便捷入口。功能与界面共用同一慢放内核。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeMedia } from '../core/probe.js';
import { renderClip } from '../core/engine.js';
import { generateSampleMedia, SAMPLE } from '../test/genmedia.js';
import { MIN_RATE, MAX_RATE } from '../core/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`技术动作慢放 CLI（辅助工具；图形入口: npm start）

用法:
  node cli/slowmo.js probe <视频文件>
  node cli/slowmo.js render <视频文件> --in <秒> --out <秒> --rate <速率> -o <输出.mp4>
  node cli/slowmo.js selftest

支持速率范围: [${MIN_RATE}, ${MAX_RATE}]，超限拒绝。`);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') opts.inSec = Number(argv[++i]);
    else if (a === '--out') opts.outSec = Number(argv[++i]);
    else if (a === '--rate') opts.rate = Number(argv[++i]);
    else if (a === '-o' || a === '--output') opts.output = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  if (cmd === 'probe') {
    const file = opts._[0];
    if (!file) return usage();
    const meta = await probeMedia(file);
    console.log(JSON.stringify(meta, null, 2));
    return;
  }

  if (cmd === 'render') {
    const file = opts._[0];
    if (!file || opts.inSec === undefined || opts.outSec === undefined || opts.rate === undefined) {
      return usage();
    }
    const output = opts.output || path.join(process.cwd(), `slowmo-${opts.rate}x.mp4`);
    const stats = await renderClip({
      inputPath: file,
      outputPath: output,
      segments: [{ inSec: opts.inSec, outSec: opts.outSec, rate: opts.rate }],
      onProgress: (p) => {
        if (p.phase === 'video') {
          process.stderr.write(`\r视频帧 ${p.frame}/${p.totalFrames}`);
        }
      },
    });
    process.stderr.write('\n');
    console.log(`输出: ${output}`);
    console.log(`采用速率: ${stats.adoptedRates.join(', ')}x，输出 ${stats.outputFrames} 帧 @ ${stats.outputFps}fps，时长 ${stats.outputDurationSec.toFixed(3)}s`);
    if (stats.audio) {
      console.log(`WSOLA 固定延迟(已补偿): ${(stats.sync.compensatedFixedLatencySec * 1000).toFixed(2)}ms，音频抖动 RMS ${(stats.sync.audioJitterRmsSec * 1000).toFixed(2)}ms`);
    }
    console.log(`实际解码速率: ${stats.decode.avgDecodeFps.toFixed(1)} 帧/s`);
    return;
  }

  if (cmd === 'selftest') {
    const dir = path.join(__dirname, '..', 'data', 'selftest');
    const sample = path.join(dir, 'sample.mp4');
    const out = path.join(dir, 'selftest-0.5x.mp4');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    console.log('生成合成运动视频…');
    await generateSampleMedia(sample);
    console.log('以 0.5x 渲染全区间…');
    const stats = await renderClip({
      inputPath: sample,
      outputPath: out,
      segments: [{ inSec: 0, outSec: SAMPLE.durationSec, rate: 0.5 }],
    });
    const expect = SAMPLE.durationSec / 0.5;
    const ok = Math.abs(stats.outputDurationSec - expect) < 0.1
      && Math.abs(stats.audio.outputDurationSec - expect) < 0.15;
    console.log(`输出时长 ${stats.outputDurationSec.toFixed(3)}s（期望 ${expect}s）: ${ok ? 'OK' : 'FAIL'}`);
    console.log(`完整验证请运行: npm test`);
    process.exit(ok ? 0 : 1);
  }

  usage();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
