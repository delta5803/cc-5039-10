import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MediaClock } from './mediaclock.js';
import { stretchWSOLA } from './wsola.js';
import { FrameDecoder, decodeAudio } from './decoder.js';
import { Mp4Encoder } from './encoder.js';
import { probeMedia } from './probe.js';
import { validateSegments } from './validate.js';
import { AUDIO_SAMPLE_RATE, AUDIO_CHANNELS, DEFAULT_OUTPUT_FPS } from './constants.js';

// 慢放渲染引擎：把 [入点,出点] + 速率（可分段）渲染成常速播放的 MP4。
// 三条速率线索彼此独立：
//   1) 播放速率 rate：媒体时钟的斜率，决定源时间推进快慢；
//   2) 实际解码速率：FrameDecoder 独立计量，只影响缓冲水位；
//   3) 输出时钟：输出帧序号 / 输出帧率，写入容器 PTS，不随前两者漂移。
export async function renderClip({
  inputPath,
  outputPath,
  segments,
  outputFps = DEFAULT_OUTPUT_FPS,
  sampleRate = AUDIO_SAMPLE_RATE,
  channels = AUDIO_CHANNELS,
  onProgress = null,
}) {
  const meta = await probeMedia(inputPath);
  validateSegments(segments, meta.durationSec);

  const clock = new MediaClock(segments);
  const outFps = outputFps || meta.fps;
  const totalOutFrames = Math.max(1, Math.round(clock.totalOutputSec * outFps));
  const hasAudio = meta.channels > 0 && meta.sampleRate > 0;

  const tmp = await mkdtemp(path.join(tmpdir(), 'slowmo-'));
  try {
    // ---- 音频：解码源区间 -> 分段 WSOLA 时间伸缩 -> 拼接 -> 临时 PCM 文件 ----
    let audioPcmPath = null;
    let audioStats = null;
    if (hasAudio) {
      onProgress?.({ phase: 'audio-decode' });
      const srcLen = clock.sourceEndSec - clock.sourceStartSec;
      const decoded = await decodeAudio(inputPath, {
        startSec: clock.sourceStartSec,
        durationSec: srcLen,
        sampleRate,
        channels,
      });

      onProgress?.({ phase: 'audio-stretch' });
      const stretchedPerSeg = [];
      let sumSqDev = 0;
      let maxAbsDev = 0;
      let grainCount = 0;
      let latencySec = 0;
      let wsolaParams = null;
      for (const seg of clock.segments) {
        const from = Math.round((seg.inSec - clock.sourceStartSec) * sampleRate);
        const to = Math.round((seg.outSec - clock.sourceStartSec) * sampleRate);
        const slice = decoded.channels.map((c) => c.subarray(from, Math.min(to, c.length)));
        const r = stretchWSOLA(slice, sampleRate, seg.rate);
        stretchedPerSeg.push(r.channels);
        latencySec = Math.max(latencySec, r.latencySec);
        wsolaParams = r.params;
        for (const g of r.grains) {
          const d = g.deviation / sampleRate;
          sumSqDev += d * d;
          if (Math.abs(d) > maxAbsDev) maxAbsDev = Math.abs(d);
          grainCount++;
        }
      }
      const totalSamples = stretchedPerSeg.reduce(
        (acc, chs) => acc + (chs[0] ? chs[0].length : 0), 0);
      const merged = Array.from({ length: channels }, () => new Float32Array(totalSamples));
      let off = 0;
      for (const chs of stretchedPerSeg) {
        for (let c = 0; c < channels; c++) merged[c].set(chs[c], off);
        off += chs[0].length;
      }
      audioPcmPath = path.join(tmp, 'audio.pcm');
      const interleaved = Buffer.alloc(totalSamples * channels * 4);
      for (let i = 0; i < totalSamples; i++) {
        for (let c = 0; c < channels; c++) {
          interleaved.writeFloatLE(merged[c][i], (i * channels + c) * 4);
        }
      }
      await writeFile(audioPcmPath, interleaved);
      audioStats = {
        fixedLatencySec: latencySec,          // WSOLA 固定算法延迟（常量，同步对账时一次性扣除）
        jitterRmsSec: grainCount ? Math.sqrt(sumSqDev / grainCount) : 0,
        jitterMaxAbsSec: maxAbsDev,
        grains: grainCount,
        params: wsolaParams,
        outputSamples: totalSamples,
        outputDurationSec: totalSamples / sampleRate,
      };
    }

    // ---- 视频：按媒体时钟逐输出帧取源帧 ----
    const decoder = new FrameDecoder(inputPath, {
      startSec: Math.max(0, clock.sourceStartSec - 0.5),
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
    });
    decoder.setConsumptionRate(clock.segmentAt(0).rate);

    const encoder = new Mp4Encoder(outputPath, {
      width: meta.width,
      height: meta.height,
      fps: outFps,
      sampleRate,
      channels,
      audioPcmPath,
    });

    let pickErrSumSq = 0;
    let pickErrMax = 0;
    let currentSeg = clock.segmentAt(0);
    for (let k = 0; k < totalOutFrames; k++) {
      const outT = k / outFps;
      const seg = clock.segmentAt(outT);
      if (seg !== currentSeg) {
        currentSeg = seg;
        decoder.setConsumptionRate(seg.rate); // 速率切换：协调缓冲消耗
      }
      const tSrc = clock.sourceTimeAt(outT);
      const frame = await decoder.frameAt(tSrc);
      const pts = decoder.currentPts();
      if (pts !== null) {
        const err = pts - tSrc;
        pickErrSumSq += err * err;
        if (Math.abs(err) > pickErrMax) pickErrMax = Math.abs(err);
      }
      await encoder.writeFrame(frame);
      if (onProgress && (k % 30 === 0 || k === totalOutFrames - 1)) {
        onProgress({ phase: 'video', frame: k + 1, totalFrames: totalOutFrames });
      }
    }
    const encStats = await encoder.finish();
    const decStats = decoder.stats();
    await decoder.close();

    // ---- 输出文件复核：容器级音/视频流时长差 ----
    const outMeta = await probeMedia(outputPath);
    const outAudioDur = audioStats ? audioStats.outputDurationSec : null;
    const outVideoDur = totalOutFrames / outFps;

    return {
      input: meta,
      segments: clock.segments.map((s) => ({
        inSec: s.inSec, outSec: s.outSec, rate: s.rate,
        outStart: s.outStart, outEnd: s.outEnd,
      })),
      adoptedRates: clock.segments.map((s) => s.rate), // 校验通过即原样采用，不做静默夹取
      outputFps: outFps,
      outputFrames: totalOutFrames,
      outputDurationSec: outVideoDur,
      audio: audioStats,
      decode: decStats,
      encode: encStats,
      sync: {
        // 固定延迟（WSOLA 窗长）已在管道对账中扣除，不计入失步；
        // 以下为扣除后的实测残余：音频取粒抖动 + 视频取帧误差。
        compensatedFixedLatencySec: audioStats ? audioStats.fixedLatencySec : 0,
        audioJitterRmsSec: audioStats ? audioStats.jitterRmsSec : 0,
        audioJitterMaxAbsSec: audioStats ? audioStats.jitterMaxAbsSec : 0,
        videoPickErrorRmsSec: Math.sqrt(pickErrSumSq / totalOutFrames),
        videoPickErrorMaxAbsSec: pickErrMax,
        containerVideoDurationSec: outVideoDur,
        containerAudioDurationSec: outAudioDur,
        containerAvDurationDiffSec: outAudioDur === null ? null : outAudioDur - outVideoDur,
      },
      output: outMeta,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
