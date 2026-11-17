// WSOLA（Waveform Similarity Overlap-Add）音频时间伸缩：改变时长、尽量保持音高。
// 多声道联动：在混合单声道上做相关搜索，所有声道共用同一取粒位置，避免声像漂移。
//
// 同步所需的元数据：
//  - latencySec：算法固定延迟（首个输出样本需要一整窗输入），渲染对账时一次性扣除，
//    它是常量管道延迟，不是随时间累积的失步。
//  - grains[].deviation：每个合成粒实际输入位置相对名义位置的偏移（由相关搜索选出），
//    其统计量即为音频时钟相对媒体时钟的真实残余抖动。

import {
  WSOLA_WINDOW_MS,
  WSOLA_OVERLAP_RATIO,
  WSOLA_MAX_DEVIATION_MS,
} from './constants.js';

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// channels: Float32Array[]（等长）；rate: 播放速率（0.5 = 半速，输出时长翻倍）
export function stretchWSOLA(channels, sampleRate, rate, options = {}) {
  const numCh = channels.length;
  const inLen = channels[0].length;
  if (inLen === 0) {
    return {
      channels: channels.map(() => new Float32Array(0)),
      outputSamples: 0,
      latencySec: 0,
      grains: [],
      jitter: { rmsSec: 0, maxAbsSec: 0 },
      params: {},
    };
  }

  const L = nextPow2(Math.round((WSOLA_WINDOW_MS / 1000) * sampleRate));
  const Hs = Math.max(1, Math.round(L / WSOLA_OVERLAP_RATIO)); // 合成步长（输出样本）
  const Ha = Math.max(1, Math.round(Hs * rate));               // 分析步长（输入样本）
  const maxDev = Math.round((WSOLA_MAX_DEVIATION_MS / 1000) * sampleRate);
  const win = hannWindow(L);

  const targetOut = Math.round(inLen / rate);

  // 混合单声道供相关搜索
  const mono = new Float32Array(inLen);
  for (let i = 0; i < inLen; i++) {
    let s = 0;
    for (let c = 0; c < numCh; c++) s += channels[c][i];
    mono[i] = s / numCh;
  }

  const out = Array.from({ length: numCh }, () => new Float32Array(targetOut + L));
  const norm = new Float32Array(targetOut + L);
  const grains = [];

  const overlapLen = L - Hs; // 与已合成输出重叠、用于相似度匹配的长度

  let outPos = 0;
  let inNominal = 0;
  while (outPos < targetOut) {
    let bestDev = 0;
    if (outPos > 0 && maxDev > 0) {
      // 粗搜（步长 8）+ 精修（步长 1），在 [-maxDev, maxDev] 内最大化归一化相关
      const lo = Math.max(-maxDev, -inNominal); // 保证输入起点不为负
      const hi = maxDev;
      let bestCorr = -Infinity;

      let outEnergy = 0;
      for (let i = 0; i < overlapLen; i++) {
        const v = out[0][outPos + i];
        outEnergy += v * v;
      }
      const outNorm = Math.sqrt(outEnergy) || 1;

      const evalAt = (d) => {
        const base = inNominal + d;
        let dot = 0, inEnergy = 0;
        for (let i = 0; i < overlapLen; i++) {
          const idx = base + i;
          const s = idx >= 0 && idx < inLen ? mono[idx] : 0;
          dot += out[0][outPos + i] * s;
          inEnergy += s * s;
        }
        return dot / (outNorm * (Math.sqrt(inEnergy) || 1));
      };

      for (let d = lo; d <= hi; d += 8) {
        const c = evalAt(d);
        if (c > bestCorr) { bestCorr = c; bestDev = d; }
      }
      const rLo = Math.max(lo, bestDev - 8);
      const rHi = Math.min(hi, bestDev + 8);
      for (let d = rLo; d <= rHi; d++) {
        const c = evalAt(d);
        if (c > bestCorr) { bestCorr = c; bestDev = d; }
      }
    }

    const inStart = inNominal + bestDev;
    for (let i = 0; i < L; i++) {
      const idx = inStart + i;
      const w = win[i];
      const o = outPos + i;
      for (let c = 0; c < numCh; c++) {
        const s = idx >= 0 && idx < inLen ? channels[c][idx] : 0;
        out[c][o] += w * s;
      }
      norm[o] += w;
    }
    grains.push({ outStart: outPos, inStart: inStart, deviation: bestDev });

    outPos += Hs;
    inNominal += Ha;
  }

  // 归一化并裁剪到目标长度
  const result = out.map((buf) => {
    const trimmed = new Float32Array(targetOut);
    for (let i = 0; i < targetOut; i++) {
      trimmed[i] = norm[i] > 1e-8 ? buf[i] / norm[i] : 0;
    }
    return trimmed;
  });

  // 抖动统计：实际取粒位置相对名义位置的偏差（秒）
  let sumSq = 0, maxAbs = 0;
  for (const g of grains) {
    const devSec = g.deviation / sampleRate;
    sumSq += devSec * devSec;
    if (Math.abs(devSec) > maxAbs) maxAbs = Math.abs(devSec);
  }
  const rmsSec = grains.length ? Math.sqrt(sumSq / grains.length) : 0;

  return {
    channels: result,
    outputSamples: targetOut,
    latencySec: L / sampleRate, // 固定算法延迟：产出首个样本前需缓冲一整窗输入
    grains,
    jitter: { rmsSec, maxAbsSec: maxAbs },
    params: { windowSamples: L, synthesisHop: Hs, analysisHop: Ha, maxDeviationSamples: maxDev },
  };
}
