// Demo clip list shared by the dev server and the browser test harness.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEMOS = [
  {
    file: 'tests/fixtures/numbered-640x360-30fps.mp4',
    label: '编号帧 · 30 fps',
    description: '每帧带编号，用于核对取帧位置；音频含持续音与脉冲。',
  },
  {
    file: 'tests/fixtures/pulses-320x240-25fps.mp4',
    label: '脉冲音 · 25 fps',
    description: '每 0.5 秒一个位置脉冲，用于核对音画位置。',
  },
];

export function demoList() {
  return DEMOS.filter((d) => fs.existsSync(path.join(ROOT, d.file))).map((d) => ({
    label: d.label,
    description: d.description,
    url: `/${d.file}`,
  }));
}

export { ROOT };
