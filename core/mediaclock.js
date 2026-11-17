// 共同媒体时钟：输出时间轴 -> 源时间轴 的分段线性映射。
// 视频取帧与音频拉伸都以此时钟为准，保证两者走同一条时间曲线，
// 而不是各自用定时器近似。

export class MediaClock {
  // segments: [{inSec, outSec, rate}]，按源时间首尾相接（validate.js 已校验）
  constructor(segments) {
    this.segments = [];
    let outCursor = 0;
    for (const seg of segments) {
      const outDur = (seg.outSec - seg.inSec) / seg.rate;
      this.segments.push({
        inSec: seg.inSec,
        outSec: seg.outSec,
        rate: seg.rate,
        outStart: outCursor,
        outEnd: outCursor + outDur,
      });
      outCursor += outDur;
    }
    this.totalOutputSec = outCursor;
    this.sourceStartSec = this.segments[0].inSec;
    this.sourceEndSec = this.segments[this.segments.length - 1].outSec;
  }

  // 输出时间 -> 源时间
  sourceTimeAt(outputSec) {
    const t = Math.min(Math.max(outputSec, 0), this.totalOutputSec);
    for (const seg of this.segments) {
      if (t <= seg.outEnd || seg === this.segments[this.segments.length - 1]) {
        return seg.inSec + (t - seg.outStart) * seg.rate;
      }
    }
    return this.sourceEndSec;
  }

  // 源时间 -> 输出时间（反函数，用于把源事件时刻换算到输出轴）
  outputTimeAt(sourceSec) {
    for (const seg of this.segments) {
      if (sourceSec <= seg.outSec || seg === this.segments[this.segments.length - 1]) {
        const s = Math.min(Math.max(sourceSec, seg.inSec), seg.outSec);
        return seg.outStart + (s - seg.inSec) / seg.rate;
      }
    }
    return this.totalOutputSec;
  }

  // 输出第 k 帧（输出帧率 outputFps）对应的源帧号（源帧率 sourceFps）
  sourceFrameAtOutputFrame(k, outputFps, sourceFps) {
    const srcTime = this.sourceTimeAt(k / outputFps);
    return Math.floor(srcTime * sourceFps + 1e-9);
  }

  // 当前输出时刻所处的分段（缓冲管理据此调整消耗速率）
  segmentAt(outputSec) {
    for (const seg of this.segments) {
      if (outputSec < seg.outEnd) return seg;
    }
    return this.segments[this.segments.length - 1];
  }
}
