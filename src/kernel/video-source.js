// Decodes the video track with WebCodecs and keeps upcoming frames available.
//
// Video is consumed by "frame at program time", not by wall-clock playback:
// the selector in the app advances the media clock and pulls whichever decoded
// frame's [pts, pts+duration) contains the program position. That makes slow
// motion independent of the display refresh rate.

export class VideoSource {
  constructor(track) {
    this.track = track;
    this.samples = track.samples;
    this.frames = []; // decoded VideoFrames, sorted by pts
    this.nextSample = 0;
    this.decoder = null;
    this.error = null;
    this.eof = false;
    this.closed = false;
    this.decodedCount = 0;
    this.droppedCount = 0;
    this.lastConfig = null;
  }

  static isSupported(track) {
    if (typeof VideoDecoder === 'undefined') return Promise.resolve(false);
    return VideoDecoder.isConfigSupported(VideoSource.configFor(track))
      .then((r) => r.supported)
      .catch(() => false);
  }

  static configFor(track) {
    const cfg = {
      codec: track.codec,
      codedWidth: track.width,
      codedHeight: track.height,
      optimizeForLatency: true,
    };
    if (track.description && track.description.byteLength > 0) {
      cfg.description = track.description.slice().buffer;
    }
    return cfg;
  }

  _sampleForProgram(programSeconds) {
    const samples = this.samples;
    let lo = 0;
    let hi = samples.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].pts <= programSeconds) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  _keyframeAtOrBefore(index) {
    for (let i = index; i >= 0; i--) if (this.samples[i].isKey) return i;
    return 0;
  }

  _createDecoder() {
    this.decoder = new VideoDecoder({
      output: (frame) => this._onFrame(frame),
      error: (e) => { this.error = e; },
    });
    this.decoder.configure(VideoSource.configFor(this.track));
  }

  _onFrame(frame) {
    this.decodedCount++;
    this.frames.push(frame);
    this.frames.sort((a, b) => a.timestamp - b.timestamp);
  }

  async open({ startProgram = 0 } = {}) {
    if (this.closed) throw new Error('video source closed');
    const cfg = VideoSource.configFor(this.track);
    const support = await VideoDecoder.isConfigSupported(cfg);
    if (!support.supported) throw new Error(`视频编码不受支持：${cfg.codec}`);
    for (const f of this.frames) f.close();
    this.frames = [];
    this.decodedCount = 0;
    this.droppedCount = 0;
    this.eof = false;
    this.error = null;
    this.startProgram = startProgram;
    const idx = this._sampleForProgram(startProgram);
    this.nextSample = this._keyframeAtOrBefore(idx);
    this._createDecoder();
    // Private frame retention point: we need decoded frames around the clock.
    this.retainBefore = startProgram - 0.5;
  }

  // Decode until the frame covering `targetProgram` (plus lookahead) exists.
  async fill(targetProgram, lookahead = 1.0) {
    if (this.error) throw this.error;
    if (this.closed) return;
    const targetTime = targetProgram + lookahead;
    const lastPts = this.frames.length
      ? this.frames[this.frames.length - 1].timestamp / 1e6
      : -Infinity;
    let guard = 0;
    while (!this.eof && (lastPts < targetTime || this.frames.length === 0) && guard++ < 5000) {
      if (this.nextSample >= this.samples.length) {
        this.eof = true;
        try { await this.decoder.flush(); } catch (e) { this.error = e; throw e; }
        break;
      }
      if (this.decoder.decodeQueueSize > 24) {
        await new Promise((r) => setTimeout(r, 0));
        continue;
      }
      this._decodeOne();
      await Promise.resolve();
    }
    this._trim();
  }

  _decodeOne() {
    const s = this.samples[this.nextSample++];
    this.decoder.decode(
      new EncodedVideoChunk({
        type: s.isKey ? 'key' : 'delta',
        timestamp: Math.round(s.pts * 1e6),
        duration: Math.round(s.duration * 1e6),
        data: s.data,
      }),
    );
  }

  // Decode the single sample following the current frames, used after a rate
  // change when the buffer is too shallow.
  async decodeOneAhead(lookaheadSeconds) {
    if (this.eof || this.error || this.closed) return false;
    if (this.nextSample >= this.samples.length) {
      this.eof = true;
      return false;
    }
    this._decodeOne();
    await new Promise((r) => setTimeout(r, 0));
    return true;
  }

  // The frame whose presentation interval contains programSeconds, trimmed to
  // the retained window. Returns null if not yet decoded.
  frameAt(programSeconds) {
    const frames = this.frames;
    if (!frames.length) return null;
    let lo = 0;
    let hi = frames.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].timestamp / 1e6 <= programSeconds) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (ans < 0) return frames[0];
    return frames[ans];
  }

  // Seconds of program time already decoded from `programSeconds` onward.
  get bufferedAhead() {
    if (!this.frames.length) return 0;
    const newest = this.frames[this.frames.length - 1].timestamp / 1e6;
    return Math.max(0, newest - (this.startProgram ?? 0));
  }

  get oldestPts() {
    return this.frames.length ? this.frames[0].timestamp / 1e6 : null;
  }

  // Decode into a fresh decoder and atomically swap once a frame covering
  // `programSeconds` exists. Old frames keep displaying until the swap, so a
  // loop boundary does not freeze the picture while a keyframe is decoded.
  async stageSeek(programSeconds) {
    if (this.closed) return false;
    const cfg = VideoSource.configFor(this.track);
    const frames = [];
    const idx = this._sampleForProgram(programSeconds);
    let sample = this._keyframeAtOrBefore(idx);
    let decoder = null;
    let eof = false;
    const done = () => frames.some((f) => f.timestamp / 1e6 + 1e-6 >= programSeconds) && sample >= idx;
    try {
      decoder = new VideoDecoder({
        output: (frame) => { frames.push(frame); frames.sort((a, b) => a.timestamp - b.timestamp); },
        error: () => { eof = true; },
      });
      decoder.configure(cfg);
      let guard = 0;
      while (!done() && !eof && guard++ < 2000) {
        if (this.decoder.decodeQueueSize > 16) {
          await new Promise((r) => setTimeout(r, 0));
          continue;
        }
        if (sample >= this.samples.length) {
          await decoder.flush();
          break;
        }
        const s = this.samples[sample++];
        decoder.decode(
          new EncodedVideoChunk({
            type: s.isKey ? 'key' : 'delta',
            timestamp: Math.round(s.pts * 1e6),
            duration: Math.round(s.duration * 1e6),
            data: s.data,
          }),
        );
        await Promise.resolve();
      }
      if (!frames.length) {
        decoder.close();
        return false;
      }
      // Swap.
      for (const f of this.frames) f.close();
      this.frames = frames;
      this.closeDecoder();
      this.decoder = decoder;
      this.nextSample = sample;
      this.startProgram = programSeconds;
      this.eof = false;
      this.error = null;
      this.droppedCount = 0;
      this.decodedCount = frames.length;
      this._trim();
      return true;
    } catch {
      try { decoder?.close(); } catch {}
      for (const f of frames) f.close();
      return false;
    }
  }

  _trim() {
    if (this.frames.length <= 2) return;
    // Keep a couple of frames before the clock for exact frame matching, but
    // close anything that is clearly behind.
    const cutoff = this.startProgram - 0.5;
    while (this.frames.length > 2 && this.frames[0].timestamp / 1e6 < cutoff) {
      const f = this.frames.shift();
      f.close();
      this.droppedCount++;
    }
  }

  closeDecoder() {
    try { this.decoder?.close(); } catch {}
    this.decoder = null;
  }

  close() {
    this.closed = true;
    this.closeDecoder();
    for (const f of this.frames) f.close();
    this.frames = [];
  }
}
