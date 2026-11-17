import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { BUFFER_LOOKAHEAD_SEC, BUFFER_MIN_FRAMES } from './constants.js';

// 拉取式视频解码器：按“源时间”取帧。
//  - 播放速率（consumption rate）只决定缓冲水位与预读量，不影响输出时钟；
//  - 输出时钟由编码端帧序号决定（见 encoder.js）；
//  - 实际解码速率在此独立计量（framesDecoded / 有效解码时间）。
// 缓冲协调：排队未消费帧超过高水位则 pause ffmpeg 输出流，回落到低水位再 resume；
// 水位随当前分段速率调整（速率越快，单位输出时间消耗的源帧越多，预读窗口越大）。
export class FrameDecoder {
  constructor(filePath, { startSec = 0, width, height, fps }) {
    this.filePath = filePath;
    this.startSec = Math.max(0, startSec);
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.frameBytes = width * height * 3;

    this.queue = [];          // [{ptsTime, frame}] 已解码未消费
    this.ptsQueue = [];       // showinfo 解析出的 pts，等待与帧数据配对
    this.current = null;      // 最近交付的帧
    this.paused = false;
    this.eof = false;
    this.framesDecoded = 0;
    this.startedAt = 0;
    this.pausedMs = 0;
    this.pauseStartedAt = 0;
    this.highWater = BUFFER_MIN_FRAMES;
    this.lowWater = Math.floor(BUFFER_MIN_FRAMES / 2);
    this.maxQueueSeen = 0;
    this.lastPts = null;

    this._stderrBuf = '';
    this._acc = Buffer.alloc(0);
    this._waiters = [];
  }

  // 速率变化时由引擎调用：重算水位，协调缓冲消耗
  setConsumptionRate(rate) {
    this.highWater = Math.max(
      BUFFER_MIN_FRAMES,
      Math.ceil(rate * this.fps * BUFFER_LOOKAHEAD_SEC)
    );
    this.lowWater = Math.max(1, Math.floor(this.highWater / 2));
    if (this.paused && this.queue.length < this.lowWater) this._resume();
  }

  start() {
    if (this.proc) return;
    this.startedAt = Date.now();
    this.proc = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'info',
      '-ss', this.startSec.toFixed(6),
      '-i', this.filePath,
      '-an',
      '-vf', 'showinfo',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.proc.stdout.on('data', (chunk) => this._onVideoData(chunk));
    this.proc.stdout.on('close', () => { this.eof = true; this._flushWaiters(); });
    this.proc.stderr.on('data', (chunk) => this._onStderr(chunk));
    this.proc.on('error', (err) => this._failAll(err));
    this.proc.stderr.on('data', () => {});
  }

  _onStderr(chunk) {
    this._stderrBuf += chunk.toString('utf8');
    let idx;
    while ((idx = this._stderrBuf.indexOf('\n')) >= 0) {
      const line = this._stderrBuf.slice(0, idx);
      this._stderrBuf = this._stderrBuf.slice(idx + 1);
      if (line.includes('showinfo')) {
        const m = /pts_time:([\d.eE+-]+)/.exec(line);
        if (m) this.ptsQueue.push(Number(m[1]));
      }
    }
  }

  _onVideoData(chunk) {
    this._acc = this._acc.length ? Buffer.concat([this._acc, chunk]) : chunk;
    while (this._acc.length >= this.frameBytes) {
      const frame = this._acc.subarray(0, this.frameBytes);
      this._acc = this._acc.subarray(this.frameBytes);
      let ptsTime;
      if (this.ptsQueue.length) {
        ptsTime = this.ptsQueue.shift();
      } else {
        // showinfo 行尚未到达的罕见竞态：按恒定帧率外推（CFR 媒体精确）
        ptsTime = this.lastPts === null ? this.startSec : this.lastPts + 1 / this.fps;
      }
      this.lastPts = ptsTime;
      this.framesDecoded++;
      this.queue.push({ ptsTime, frame: Buffer.from(frame) });
    }
    if (this.queue.length > this.maxQueueSeen) this.maxQueueSeen = this.queue.length;
    if (!this.paused && this.queue.length > this.highWater) this._pause();
    this._flushWaiters();
  }

  _pause() {
    this.paused = true;
    this.pauseStartedAt = Date.now();
    this.proc.stdout.pause();
  }

  _resume() {
    this.paused = false;
    this.pausedMs += Date.now() - this.pauseStartedAt;
    this.proc.stdout.resume();
  }

  _flushWaiters() {
    const ready = this._waiters;
    this._waiters = [];
    for (const w of ready) w();
  }

  _failAll(err) {
    this.eof = true;
    this.error = err;
    this._flushWaiters();
  }

  _waitData() {
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  // 取“最接近源时间 tSec 的帧”（最近邻）。调用方保证 tSec 单调不减。
  async frameAt(tSec) {
    this.start();
    const eps = 1e-9;
    for (;;) {
      if (this.error) throw this.error;
      while (this.queue.length && this.queue[0].ptsTime <= tSec + eps) {
        this.current = this.queue.shift();
      }
      if (this.paused && this.queue.length < this.lowWater) this._resume();
      if (this.queue.length) {
        const next = this.queue[0];
        if (!this.current) {
          this.current = next; // 首帧尚未交付：直接取最早可用帧
          return next.frame;
        }
        if (tSec - this.current.ptsTime <= next.ptsTime - tSec) {
          return this.current.frame;
        }
        this.current = next; // 窥看但不弹出，后续请求仍会消费它
        return next.frame;
      }
      if (this.eof) {
        if (this.current) return this.current.frame; // 请求越过末尾：冻结在最后一帧
        throw new Error('解码结束但未获得任何帧');
      }
      await this._waitData();
    }
  }

  // 当前已交付帧的源时间（供引擎计算取帧误差）
  currentPts() {
    return this.current ? this.current.ptsTime : null;
  }

  stats() {
    const activeMs = Math.max(1, Date.now() - this.startedAt - this.pausedMs);
    return {
      framesDecoded: this.framesDecoded,
      decodeActiveSec: activeMs / 1000,
      avgDecodeFps: this.framesDecoded / (activeMs / 1000),
      highWaterFrames: this.highWater,
      maxQueueSeen: this.maxQueueSeen,
    };
  }

  async close() {
    if (this.proc && !this.eof) {
      this.proc.stdout.destroy();
      this.proc.kill('SIGKILL');
    }
    this.eof = true;
    this._flushWaiters();
  }
}

// 音频整段解码为浮点 PCM（按声道分离）
export async function decodeAudio(filePath, { startSec = 0, durationSec, sampleRate, channels }) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', startSec.toFixed(6),
    '-i', filePath,
    '-t', durationSec.toFixed(6),
    '-vn',
    '-f', 'f32le',
    '-ac', String(channels),
    '-ar', String(sampleRate),
    'pipe:1',
  ];
  const chunks = [];
  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`音频解码失败(code=${code}): ${stderr.slice(-500)}`));
      else resolve();
    });
  });
  const buf = Buffer.concat(chunks);
  const frames = Math.floor(buf.length / (4 * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      out[c][i] = buf.readFloatLE((i * channels + c) * 4);
    }
  }
  return { channels: out, frames, sampleRate };
}
