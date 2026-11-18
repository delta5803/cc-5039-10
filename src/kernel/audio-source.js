// Decodes the audio track into program-time PCM blocks.
//
// Every block carries an exact `start` in program sample frames at the source
// sample rate. Timestamps come from the demuxer after edit-list correction, so
// program 0 is the first audible sample. Codec priming packets are decoded (to
// keep the decoder state valid) and then clipped, never presented.

export class AudioSource {
  constructor(track) {
    this.track = track;
    this.sampleRate = track.sampleRate || 48000;
    this.channels = Math.max(1, track.channels || 1);
    this.chunks = track.samples;
    this.decoder = null;
    this.error = null;
    this.blocks = [];
    this.packet = 0;
    this.seekStart = 0;
    this.eof = false;
    this.closed = false;
    this.decodedFrames = 0;
  }

  static isSupported(track) {
    if (typeof AudioDecoder === 'undefined') return Promise.resolve(false);
    return AudioDecoder.isConfigSupported(AudioSource.configFor(track))
      .then((r) => r.supported)
      .catch(() => false);
  }

  static configFor(track) {
    const cfg = {
      codec: track.codec,
      sampleRate: track.sampleRate,
      numberOfChannels: track.channels,
    };
    if (track.description && track.description.byteLength > 0) {
      cfg.description = track.description.slice().buffer;
    }
    return cfg;
  }

  _packetForTime(seconds) {
    const samples = this.chunks;
    if (!samples.length) return 0;
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (samples[mid].pts <= seconds) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  async open({ startProgram = 0 } = {}) {
    if (this.closed) throw new Error('audio source closed');
    const cfg = AudioSource.configFor(this.track);
    const support = await AudioDecoder.isConfigSupported(cfg);
    if (!support.supported) throw new Error(`音频编码不受支持：${cfg.codec}`);
    this.seekStart = Math.max(0, startProgram);
    // Back up one packet so MDCT history is valid at the seek point.
    this.packet = Math.max(0, this._packetForTime(this.seekStart) - 1);
    this.blocks = [];
    this.eof = false;
    this.error = null;
    this.decodedFrames = 0;
    this.decoder = new AudioDecoder({
      output: (frame) => this._onFrame(frame),
      error: (e) => { this.error = e; },
    });
    this.decoder.configure(cfg);
  }

  _onFrame(frame) {
    const frames = frame.numberOfFrames;
    const programStart = Math.round((frame.timestamp / 1e6) * this.sampleRate);
    const planar = [];
    for (let c = 0; c < this.channels; c++) {
      const arr = new Float32Array(frames);
      try {
        frame.copyTo(arr, { planeIndex: Math.min(c, frame.numberOfChannels - 1), format: 'f32-planar' });
      } catch {
        arr.fill(0);
      }
      planar.push(arr);
    }
    this.decodedFrames += frames;
    frame.close();

    const blockEnd = programStart + frames;
    const clipStart = Math.max(programStart, 0, Math.round(this.seekStart * this.sampleRate));
    if (blockEnd <= clipStart) return;
    const skip = clipStart - programStart;
    this.blocks.push({ start: clipStart, planar: skip ? planar.map((ch) => ch.subarray(skip)) : planar });
  }

  get bufferEnd() {
    if (!this.blocks.length) return Math.round(this.seekStart * this.sampleRate);
    const b = this.blocks[this.blocks.length - 1];
    return b.start + b.planar[0].length;
  }

  // Decode until `targetEndSeconds` of program audio is buffered.
  async fill(targetEndSeconds) {
    if (this.error) throw this.error;
    if (this.closed) return 0;
    const targetFrame = Math.ceil(targetEndSeconds * this.sampleRate);
    let fed = 0;
    while (this.bufferEnd < targetFrame && !this.eof) {
      if (this.error) throw this.error;
      if (this.packet >= this.chunks.length) {
        this.eof = true;
        if (this.decoder && this.decoder.state === 'configured') {
          try { await this.decoder.flush(); } catch (e) { this.error = e; throw e; }
        }
        break;
      }
      if (this.decoder.decodeQueueSize > 48) {
        await new Promise((r) => setTimeout(r, 0));
        continue;
      }
      const s = this.chunks[this.packet++];
      this.decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round(s.pts * 1e6),
          duration: Math.round(s.duration * 1e6),
          data: s.data,
        }),
      );
      fed++;
      await Promise.resolve();
    }
    return fed;
  }

  // Remove and return buffered blocks that begin before `upToProgramSeconds`,
  // clipping the final block at the limit.
  take(upToProgramSeconds) {
    const limit = Math.ceil(upToProgramSeconds * this.sampleRate);
    const out = [];
    while (this.blocks.length) {
      const b = this.blocks[0];
      const bEnd = b.start + b.planar[0].length;
      if (bEnd <= limit) {
        out.push(this.blocks.shift());
      } else if (b.start < limit) {
        const take = limit - b.start;
        out.push({ start: b.start, planar: b.planar.map((ch) => ch.subarray(0, take)) });
        this.blocks[0] = { start: limit, planar: b.planar.map((ch) => ch.subarray(take)) };
        break;
      } else break;
    }
    return out;
  }

  get oldestBuffered() {
    return this.blocks.length ? this.blocks[0].start : null;
  }

  closeDecoder() {
    try { this.decoder?.close(); } catch {}
    this.decoder = null;
    this.blocks = [];
    this.eof = false;
    this.error = null;
  }

  close() {
    this.closed = true;
    this.closeDecoder();
  }
}
