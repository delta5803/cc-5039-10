// Slow-motion engine.
//
// One shared timeline drives everything:
//   output clock  : AudioContext.currentTime (hardware-timed, real time)
//   program clock : derived from the audio renderer's consumed output samples,
//                   which is the only element with a real hardware output.
//                   With no audio the output clock is interpolated by rate.
//
// Playback rate is expressed as a slope between output time and program time.
// Timers keep running at their normal cadence; nothing is slowed down by
// stretching an interval.
//
// Looping is implemented as explicit segment cuts on one continuous output
// timeline. WSOLA output placed at output sample N is tagged with the exact
// program position and rate it was produced at, so presentation can be mapped
// with no accumulated drift. A loop wrap is a hard cut (matching a real
// repeated take); the video decoder is pre-staged across the boundary.
//
// Fixed delays (WSOLA lookahead, device base/output latency) are measured and
// reported separately from clock deviation so a constant offset is never
// mistaken for permanent loss of sync.

import { AudioSource } from './audio-source.js';
import { VideoSource } from './video-source.js';
import { Wsola } from './wsola.js';
import { LoopTimeline } from './clock.js';
import { resolveRate, RATE_POLICY } from './rates.js';

const WORKLET_MODULE = new URL('../worklet/renderer.worklet.js', import.meta.url);

const RING_TARGET_SECONDS = 0.16;
const RING_LOW_SECONDS = 0.07;
const RING_REFILL_TIMEOUT_MS = 6;
const AUDIO_SOURCE_LEAD = 1.0; // program seconds of decoded source beyond WSOLA demand
const VIDEO_LOOKAHEAD = 1.5; // program seconds of decoded video
const TICK_MS = 16;

export class SlowmoEngine extends EventTarget {
  constructor({ audioContext = null } = {}) {
    super();
    this.ctx = audioContext;
    this.media = null;
    this.audio = null;
    this.video = null;
    this.wsola = null;
    this.node = null;
    this.timeline = null;
    this.rateInfo = resolveRate(1);
    this.playing = false;
    this.ready = false;
    this.frameHook = null;
    this.region = { start: 0, end: 0 };
    this.programDuration = 0;
    this.loop = true;

    this.outAnchorCtx = null; // AudioContext time of output clock 0
    this.rateSegments = []; // { out, program, rate } ascending, first at out 0
    this.audioNextProgram = 0; // position within the current region pass
    this.virtualPushed = 0; // continuous virtual position of the next WSOLA output
    this.cutPoints = [];
    this._cutPending = false;
    this.pushedOut = 0; // output samples posted to the renderer
    this.audioConsumed = 0; // last measured consumed output samples
    this.workletStartedAt = null;
    this.workletStats = null;
    this.presentPosition = 0;
    this.presentSource = 'seek';
    this.lastPresentVirtual = 0;
    this.audioUnderruns = 0;
    this.clockDeviation = 0;
    this.deviationSamples = []; // recent (outputTime, deviation) pairs
    this.driftPpm = 0;
    this.lastRateAttempt = null;
    this.lastFramePts = null;
    this.renderCount = 0;
    this.lastError = null;
    this.videoStagePending = false;
    this._seekPending = false;
    this._seekDone = null;
    this.clockProgramAnchor = 0;
    this.clockOutAnchor = 0;
    this.audioLatency = { base: 0, output: 0, algorithm: 0, total: 0 };
    this._generation = 0;
    this._tickTimer = null;
    this._pumping = false;
    this._pumpQueued = false;
  }

  // ---- load / info ----

  async load(buffer, { loop = true } = {}) {
    const { demuxMp4 } = await import('./demux.js');
    this.media = await demuxMp4(buffer);
    this.programDuration = this.media.duration;
    this.loop = loop;
    this.region = { start: 0, end: this.programDuration };
    this.timeline = new LoopTimeline({ start: 0, end: this.programDuration, repeat: loop });

    const vTrack = this.media.tracks.video;
    const aTrack = this.media.tracks.audio;
    if (vTrack) {
      if (!(await VideoSource.isSupported(vTrack))) {
        throw new Error(`当前浏览器无法解码视频编码 ${vTrack.codec}`);
      }
      this.video = new VideoSource(vTrack);
    }
    if (aTrack) {
      if (!(await AudioSource.isSupported(aTrack))) {
        throw new Error(`当前浏览器无法解码音频编码 ${aTrack.codec}`);
      }
      this.audio = new AudioSource(aTrack);
      this.wsola = new Wsola({ sampleRate: this.audio.sampleRate, channels: this.audio.channels });
    } else {
      this.audio = null;
      this.wsola = null;
    }
    await this._initAudio();
    await this.seek(0, { silent: true });
    this.ready = true;
    this._emit('ready', this.info());
    return this;
  }

  info() {
    const v = this.media?.tracks.video;
    const a = this.media?.tracks.audio;
    return {
      duration: this.programDuration,
      video: v ? {
        codec: v.codec, width: v.width, height: v.height,
        frames: v.samples.length,
        fps: v.samples.length / Math.max(1e-3, this.programDuration),
      } : null,
      audio: a ? {
        codec: a.codec, sampleRate: a.sampleRate, channels: a.channels,
        packets: a.samples.length, primingSeconds: a.primingSeconds ?? 0,
      } : null,
      ratePolicy: RATE_POLICY,
      hasAudio: !!this.audio,
      hasVideo: !!this.video,
    };
  }

  async _initAudio() {
    if (!this.ctx) {
      const sr = this.audio?.sampleRate ?? 48000;
      this.ctx = new AudioContext({ sampleRate: sr, latencyHint: 'interactive' });
    }
    if (!this.node && this.ctx) {
      await this.ctx.audioWorklet.addModule(WORKLET_MODULE);
      this.node = new AudioWorkletNode(this.ctx, 'slowmo-renderer', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [this.audio?.channels ?? 2],
        processorOptions: {
          rate: this.rateInfo.adopted ?? 1,
          channels: this.audio?.channels ?? 2,
          leadSeconds: RING_TARGET_SECONDS,
        },
      });
      this.node.connect(this.ctx.destination);
      this.node.port.onmessage = (e) => this._onWorklet(e.data);
    }
    this._measureLatency();
  }

  _measureLatency() {
    const sr = this.audio?.sampleRate ?? 48000;
    const algorithm = this.wsola ? this.wsola.lookaheadOutputSamples / sr : 0;
    this.audioLatency = {
      base: this.ctx?.baseLatency ?? 0,
      output: this.ctx?.outputLatency ?? 0,
      algorithm,
    };
    this.audioLatency.total = this.audioLatency.base + this.audioLatency.output + this.audioLatency.algorithm;
  }

  _onWorklet(msg) {
    if (msg.type === 'stats') {
      this.workletStats = { ...msg, pushedAtReport: this.pushedOut };
      this.audioConsumed = Math.max(msg.consumed, this.audioConsumed);
      this.workletStartedAt = msg.startedAtContext;
      this.audioUnderruns = msg.underflows;
      this._emit('stats', this.stats());
    }
  }

  // ---- clocks ----

  get outputNow() {
    if (!this.ctx || this.outAnchorCtx === null) return 0;
    return Math.max(0, this.ctx.currentTime - this.outAnchorCtx);
  }

  // Measured consumed output samples, interpolated with the hardware clock and
  // never allowed past what we actually queued.
  get audioOutputSamples() {
    const st = this.workletStats;
    if (!st) return 0;
    let consumed = st.consumed ?? 0;
    if (st.startedAtContext !== null && st.startedAtContext !== undefined && this.ctx) {
      const estimate = Math.max(0, this.ctx.currentTime - st.startedAtContext) * (st.sampleRate || 48000);
      consumed = Math.min(this.pushedOut, Math.max(consumed, estimate));
    }
    return consumed;
  }

  _segmentsValid() {
    return this.rateSegments.length > 0;
  }

  // Map an output-sample position to the exact program position it carries,
  // using the same piecewise segments the audio was produced with.
  programAtOutputSample(sample) {
    const segs = this.rateSegments;
    if (!segs.length) {
      return { program: this.audioNextProgram, raw: this.audioNextProgram, rate: this.rateInfo.adopted ?? 1 };
    }
    const sr = this.audio?.sampleRate ?? 48000;
    let lo = 0;
    let hi = segs.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].out <= sample) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    const seg = segs[ans];
    const raw = seg.program + ((sample - seg.out) / sr) * seg.rate;
    const program = this.timeline ? this.timeline.locate(raw).position : raw;
    return { program, raw, rate: seg.rate };
  }

  // At a wrap, jumps define where the next pass begins on the continuous
  // virtual timeline.
  _addCut(out, program, rate) {
    this._addSegment(out, program, rate);
    this.cutPoints.push({ out, program });
  }

  _addSegment(out, program, rate) {
    const last = this.rateSegments[this.rateSegments.length - 1];
    if (last && out <= last.out) {
      last.program = program;
      last.rate = rate;
      return;
    }
    this.rateSegments.push({ out, program, rate });
    if (this.rateSegments.length > 800) {
      // Keep the segment covering the oldest live audio plus history.
      this.rateSegments.splice(0, 400);
    }
  }

  // Program position predicted purely by the rate slope (diagnostic reference).
  get programFromClock() {
    const sr = this.audio?.sampleRate ?? 48000;
    const dt = this.outputNow - (this.clockOutAnchor ?? 0);
    return (this.clockProgramAnchor ?? 0) + dt * (this.rateInfo.adopted ?? 1);
  }

  // ---- transport ----

  async play() {
    if (!this.ready) throw new Error('engine not ready');
    await this._whenSeeked();
    if (this.ctx?.state !== 'running') await this.ctx.resume();
    if (this.outAnchorCtx === null) this.outAnchorCtx = this.ctx.currentTime;
    // Prime the renderer before the clock starts, so playback never begins on
    // silence with the media clock already running.
    if (this.audio) await this._primeRing();
    this.clockProgramAnchor = this.lastPresentVirtual;
    this.clockOutAnchor = this.outputNow;
    this.playing = true;
    this.node?.port.postMessage({ type: 'play' });
    this.workletStartedAt = this.ctx.currentTime;
    this._startTicker();
    this._emit('state', { playing: true });
    await this._pump();
    return this;
  }

  async _primeRing() {
    const sr = this.audio.sampleRate;
    const target = Math.round(RING_TARGET_SECONDS * sr);
    for (let attempt = 0; attempt < 8; attempt++) {
      await this._pump();
      if (this._queueAhead() >= target * 0.75) return;
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.node?.port.postMessage({ type: 'pause' });
    this._stopTicker();
    this._emit('state', { playing: false });
    this._emit('stats', this.stats());
  }

  async seek(programTime, { silent = false } = {}) {
    const gen = ++this._generation;
    // A newer seek supersedes the older one: resolve its waiters so callers
    // are never left waiting on a seek that will not run to completion.
    this._seekDone?.();
    this._seekDone = null;
    this._seekPending = true;
    const t = Math.max(0, Math.min(this.programDuration, programTime));
    this.node?.port.postMessage({ type: 'flush' });
    this.pushedOut = 0;
    this.audioConsumed = 0;
    this.rateSegments = [];
    this.audioNextProgram = 0;
    this.virtualPushed = 0;
    this.cutPoints = [];
    this._cutPending = false;
    this.presentPosition = t;
    this.presentSource = 'seek';
    this._resetDrift();
    this.lastPresentVirtual = 0;
    this.presentPosition = t;
    this._applyVirtual(0);
    this.clockProgramAnchor = 0;
    this.clockOutAnchor = this.outputNow;
    this.workletStartedAt = null;
    this.workletStats = null;
    this.audioUnderruns = 0;
    this.loopIndex = 0;
    this.wsola?.reset(Math.round(t * this.audio.sampleRate));
    this.wsola?.setRate(this.rateInfo.adopted ?? 1);
    if (this.audio) {
      this.audio.closeDecoder();
      await this.audio.open({ startProgram: t });
    }
    if (gen !== this._generation) return;
    if (this.video) {
      for (const f of this.video.frames) f.close();
      this.video.frames = [];
      await this.video.open({ startProgram: t });
    }
    if (gen !== this._generation) return;
    if (this.playing) this.node?.port.postMessage({ type: 'play' });
    await this._pump();
    this.renderFrame();
    this._seekPending = false;
    this._seekDone?.();
    this._seekDone = null;
    if (!silent) this._emit('seek', { programTime: t });
  }

  // Seek is serialized: callers that need a settled position (play, region
  // changes) await this instead of racing a seek started moments earlier.
  _whenSeeked() {
    if (!this._seekPending) return Promise.resolve();
    return new Promise((resolve) => {
      const prev = this._seekDone;
      this._seekDone = () => { prev?.(); resolve(); };
    });
  }

  async setRate(value) {
    const info = resolveRate(value);
    this.lastRateAttempt = info;
    if (!info.ok) {
      this._emit('rate', info);
      this._emit('stats', this.stats());
      return info;
    }
    const before = this.lastPresentVirtual;
    this.rateInfo = info;
    this.wsola?.setRate(info.adopted);
    this.node?.port.postMessage({ type: 'setRate', rate: info.adopted });
    // Begin a new output segment at the current pushed position, anchored to
    // the continuous virtual position of the next produced sample, so audio
    // already queued keeps its original mapping.
    this._addSegment(this.pushedOut, this.virtualPushed, info.adopted);
    this.clockProgramAnchor = before;
    this.clockOutAnchor = this.outputNow;
    this._resetDrift();
    this._scheduleRateReanchor();
    this._measureLatency();
    this._emit('rate', info);
    if (this.playing) await this._pump();
    this._emit('stats', this.stats());
    return info;
  }

  setRegion({ start, end }, { loop = this.loop } = {}) {
    const s = Math.max(0, Math.min(this.programDuration, Math.min(start, end)));
    const e = Math.min(this.programDuration, Math.max(s + 0.05, Math.max(start, end)));
    this.region = { start: s, end: e };
    this.loop = loop;
    this.timeline = new LoopTimeline({ start: s, end: e, repeat: loop });
    this._emit('region', { ...this.region, loop });
    if (this.presentPosition < s || this.presentPosition >= e) this.seek(s);
    else this._emit('stats', this.stats());
  }

  setLoop(loop) {
    this.loop = loop;
    if (this.timeline) this.timeline.repeat = loop;
    this._emit('region', { ...this.region, loop });
  }

  // ---- ticker / presentation ----

  _startTicker() {
    if (this._tickTimer !== null) return;
    this._tickTimer = setInterval(() => this._tick(), TICK_MS);
  }

  _stopTicker() {
    if (this._tickTimer !== null) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  _tick() {
    this._updatePresentation();
    this.renderFrame({ alreadyUpdated: true });
    this._pump();
  }

  _updatePresentation() {
    if (!this.playing) return;
    const virtual = this.audio && this.wsola
      ? (this.programAtOutputSample(this.audioOutputSamples).raw ?? 0)
      : Math.max(0, this.programFromClock);
    this.presentSource = this.audio && this.wsola ? 'audio' : 'clock';
    this.lastPresentVirtual = virtual;
    this._applyVirtual(virtual);
    // Clock deviation: measured playhead versus a pure rate slope. Both are
    // virtual, so a loop cut is not mistaken for drift. A constant offset here
    // is queued/device latency; only a changing offset is real drift, which is
    // why drift is estimated from the slope of the deviation over time.
    this.clockDeviation = this.audio && this.wsola ? virtual - this.programFromClock : 0;
    this._trackDrift(this.clockDeviation);
  }

  _trackDrift(deviation) {
    const now = this.outputNow;
    const hist = this.deviationSamples;
    hist.push({ t: now, d: deviation });
    while (hist.length > 2 && now - hist[0].t > 2.0) hist.shift();
    if (hist.length >= 4 && now - hist[0].t > 0.6) {
      const first = hist[0];
      const last = hist[hist.length - 1];
      const dt = last.t - first.t;
      if (dt > 0.4) this.driftPpm = ((last.d - first.d) / dt) * 1e6;
    }
  }

  // Audio already queued when the rate changes was produced at the old rate,
  // so the playhead and the new-rate reference diverge until that queue drains.
  // Re-anchor once it has, leaving only genuine residual offset.
  _scheduleRateReanchor() {
    clearTimeout(this._reanchorTimer);
    const sr = this.audio?.sampleRate ?? 48000;
    const drainMs = ((this._queueAhead() / sr) * 1000) + 60;
    this._reanchorTimer = setTimeout(() => {
      if (!this.playing) return;
      this.clockProgramAnchor = this.lastPresentVirtual;
      this.clockOutAnchor = this.outputNow;
      this._resetDrift();
    }, drainMs);
  }

  _resetDrift() {
    this.deviationSamples = [];
    this.driftPpm = 0;
    this.clockDeviation = 0;
  }

  regionSpan() {
    return this.region.end - this.region.start;
  }

  _applyVirtual(virtual) {
    const loc = this.timeline
      ? this.timeline.locate(virtual)
      : { loopIndex: 0, position: this.region.start + virtual };
    this.presentPosition = loc.position;
    this.loopIndex = loc.loopIndex;
  }

  get programTime() {
    return this.presentPosition;
  }

  renderFrame({ alreadyUpdated = false } = {}) {
    if (!alreadyUpdated) this._updatePresentation();
    if (!this.video) return null;
    const t = this.presentPosition;
    const frame = this.video.frameAt(t);
    if (frame) {
      this.lastFramePts = frame.timestamp / 1e6;
      this.frameHook?.(frame, { programTime: t, source: this.presentSource });
      this.renderCount++;
    }
    return { programTime: t, frame };
  }

  // ---- decoding pump ----

  _ringBuffered() {
    const st = this.workletStats;
    if (!st) return 0;
    return st.buffered ?? 0;
  }

  _hasStarvedRing() {
    return !this.workletStats || this._ringBuffered() < RING_LOW_SECONDS * (this.audio?.sampleRate ?? 48000);
  }

  async _pump() {
    if (!this.ready) return;
    if (this._pumping) {
      this._pumpQueued = true;
      return;
    }
    this._pumping = true;
    try {
      const gen = this._generation;
      if (this.audio && this.wsola) {
        const demand = Math.min(
          this.programDuration,
          this.audioNextProgram + AUDIO_SOURCE_LEAD,
        );
        await this.audio.fill(demand);
        if (gen !== this._generation) return;
        await this._fillRing();
        if (gen !== this._generation) return;
      }
      if (this.video) {
        const target = this.presentPosition;
        if (this.videoStagePending) {
          this.videoStagePending = false;
          // The audio wrap can lead the displayed position by most of a ring;
          // stage at the region start, which is where the next pass begins.
          await this.video.stageSeek(this.region.start);
          if (gen !== this._generation) return;
        }
        await this.video.fill(target, VIDEO_LOOKAHEAD * (this.rateInfo.adopted ?? 1));
        if (gen !== this._generation) return;
      }
      this._emit('stats', this.stats());
    } catch (e) {
      this.lastError = e;
      this._emit('error', { error: e });
    } finally {
      this._pumping = false;
      if (this._pumpQueued) {
        this._pumpQueued = false;
        queueMicrotask(() => this._pump());
      }
    }
  }

  // Fill the renderer ring with WSOLA output, cutting at region boundaries.
  async _fillRing() {
    const sr = this.audio.sampleRate;
    const rate = this.rateInfo.adopted ?? 1;
    const targetFrames = Math.round(RING_TARGET_SECONDS * sr);
    const span = this.region.end - this.region.start;
    let guard = 0;
    // No new audio can be produced past the region end when not looping.
    if (!this.loop && this.audioNextProgram >= span - 1e-6) return;

    while (guard++ < 64) {
      const buffered = this._queueAhead();
      if (buffered >= targetFrames) break;
      const { start, end } = this.region;

      // Loop wrap: audio for this iteration is fully queued. Cut cleanly and
      // restage the decoder on the other side of the boundary.
      if (this.audioNextProgram >= span - 1e-6) {
        if (this.loop && span > 1e-3) {
          await this._cutToRegionStart();
          continue;
        }
        break; // stop at end when not looping
      }

      // Decode source far enough ahead for the next WSOLA frames. Source
      // position is virtual position offset by the region start.
      const sourcePos = start + this.audioNextProgram;
      const needUntil = Math.min(this.programDuration, sourcePos + AUDIO_SOURCE_LEAD);
      if (this.wsola.inputEnd < needUntil * sr) {
        await this.audio.fill(needUntil);
        this._feedWsola(needUntil, sr);
      }
      // WSOLA needs one frame plus search window of lookahead. At the end of
      // the media there is no source left beyond that point, so pad it with
      // silence; without this the last ~35 ms of a pass can never be rendered
      // and a loop whose region ends at the program end would stall there.
      if (!this.wsola.ended && this.wsola.inputEnd >= this.programDuration * sr - 1) {
        this.wsola.endOfInput();
      }

      let want = Math.min(4096, Math.ceil(targetFrames - buffered) + 1024);
      if (this.loop) {
        const remaining = Math.max(0, span - this.audioNextProgram);
        const untilEnd = Math.ceil((remaining / rate) * sr);
        want = Math.min(want, untilEnd);
      }
      if (want <= 0) continue;

      const l = new Float32Array(want);
      const r = new Float32Array(want);
      const planar = this.audio.channels > 1 ? [l, r] : [l];
      const n = this.wsola.render(planar);
      if (n <= 0) {
        if (this.wsola.underrun) {
          // Genuinely waiting on the decoder; retry shortly in the pump.
          break;
        }
        break;
      }
      if (this._cutPending) {
        // The first sample after a wrap starts the next pass, whose virtual
        // position is exactly virtualPushed (it advanced by one span during
        // the pass that just finished).
        this._addCut(this.pushedOut, this.virtualPushed, rate);
        this._cutPending = false;
      } else {
        this._addSegment(this.pushedOut, this.virtualPushed, rate);
      }
      this.audioNextProgram += (n / sr) * rate;
      this.virtualPushed += (n / sr) * rate;
      this.pushedOut += n;
      this.node.port.postMessage(
        {
          type: 'audio',
          left: l.subarray(0, n),
          right: (planar[1] ?? l).subarray(0, n),
        },
        [l.buffer.slice(0, n * 4), (planar[1] ?? l).buffer.slice(0, n * 4)],
      );
    }
  }

  _feedWsola(untilProgram, sr) {
    const have = this.wsola.inputEnd;
    const wantUntil = Math.min(Math.round(untilProgram * sr), Math.ceil(this.programDuration * sr));
    if (wantUntil <= have) return;
    const blocks = this.audio.take(wantUntil / sr);
    for (const b of blocks) {
      const bEnd = b.start + b.planar[0].length;
      if (bEnd <= have) continue;
      let planar = b.planar;
      let startSample = b.start;
      if (b.start < have) {
        const skip = have - b.start;
        planar = b.planar.map((ch) => ch.subarray(skip));
        startSample = have;
      }
      this.wsola.push(planar, startSample);
    }
  }

  async _cutToRegionStart() {
    const sr = this.audio.sampleRate;
    const t = this.region.start;
    // The cut continues the virtual timeline at this pass's end so positions
    // stay monotonic; the following audio restarts at virtual 0 of a new pass.
    this._cutPending = true; // recorded with the next produced sample
    this.audioNextProgram = 0;
    this.wsola.reset(Math.round(t * sr));
    this.wsola.setRate(this.rateInfo.adopted ?? 1);
    this.audio.closeDecoder();
    await this.audio.open({ startProgram: t });
    this._feedWsola(Math.min(this.programDuration, t + AUDIO_SOURCE_LEAD), sr);
    if (this.video) this.videoStagePending = true;
  }

  // Output frames pushed beyond what the device has consumed.
  _queueAhead() {
    return Math.max(0, this.pushedOut - this.audioOutputSamples);
  }

  // ---- stats ----

  stats() {
    const sr = this.audio?.sampleRate ?? 48000;
    const position = this.presentPosition;
    const loopIndex = this.loopIndex ?? 0;
    const consumed = this.audioConsumed;
    const mapped = this.audio ? this.programAtOutputSample(this.audioOutputSamples) : null;
    return {
      playing: this.playing,
      ready: this.ready,
      rate: {
        requested: this.rateInfo.requested,
        adopted: this.rateInfo.adopted,
        tier: this.rateInfo.tier,
        degraded: this.rateInfo.degraded,
        message: this.rateInfo.message,
        min: RATE_POLICY.min,
        max: RATE_POLICY.max,
        qualityMin: RATE_POLICY.qualityMin,
        qualityMax: RATE_POLICY.qualityMax,
      },
      position,
      positionSource: this.presentSource,
      lastRateAttempt: this.lastRateAttempt ? {
        requested: this.lastRateAttempt.requested,
        ok: this.lastRateAttempt.ok,
        message: this.lastRateAttempt.message,
        code: this.lastRateAttempt.code ?? null,
      } : null,
      programDuration: this.programDuration,
      region: { ...this.region },
      loop: this.loop,
      loopIndex,
      clock: {
        outputNow: this.outputNow,
        programFromClock: this.programFromClock,
        programFromAudio: mapped ? mapped.program : null,
        deviationSeconds: this.clockDeviation,
        driftPpm: this.driftPpm,
        audioOutSeconds: consumed / sr,
        audioRingSeconds: this._queueAhead() / sr,
        audioUnderruns: this.workletStats?.underflows ?? 0,
        videoAheadSeconds: this.video ? this.video.bufferedAhead : 0,
        videoFramesReady: this.video ? this.video.frames.length : 0,
        sourceLeadSeconds: this.audio ? this.audio.bufferEnd / sr - this.presentPosition : 0,
      },
      latency: { ...this.audioLatency },
      av: {
        framePts: this.lastFramePts,
        deltaSeconds: this.lastFramePts === null ? null : this.lastFramePts - position,
      },
      wsola: this.wsola ? {
        frames: this.wsola.frames,
        lookaheadMs: (this.wsola.lookaheadOutputSamples / sr) * 1000,
        starvedFrames: this.wsola.starvedFrames,
      } : null,
      video: this.video ? { dropped: this.video.droppedCount, decoded: this.video.decodedCount } : null,
      lastError: this.lastError ? String(this.lastError.message ?? this.lastError) : null,
    };
  }

  // ---- diagnostics ----

  // Decode a program interval offline through the same WSOLA chain. Tests use
  // this to verify duration and pitch of the real processing path.
  async renderProgramSegment(fromProgram, toProgram, { rate = this.rateInfo.adopted ?? 1 } = {}) {
    const sr = this.audio.sampleRate;
    const wsola = new Wsola({ sampleRate: sr, channels: this.audio.channels });
    wsola.setRate(rate);
    const source = new AudioSource(this.audio.track);
    await source.open({ startProgram: fromProgram });
    await source.fill(toProgram + 0.3);
    const blocks = source.take(toProgram);
    let expect = Math.round(fromProgram * sr);
    for (const b of blocks) {
      if (b.start > expect) {
        const gap = new Float32Array(b.start - expect);
        wsola.push(b.planar.map(() => gap), expect);
        expect = b.start;
      }
      if (b.start < expect) continue;
      wsola.push(b.planar, b.start);
      expect = b.start + b.planar[0].length;
    }
    wsola.endOfInput();
    const total = Math.round(((toProgram - fromProgram) / rate) * sr);
    const out = Array.from({ length: this.audio.channels }, () => new Float32Array(total));
    const tmp = Array.from({ length: this.audio.channels }, () => new Float32Array(1024));
    let written = 0;
    while (written < total) {
      const n = wsola.render(tmp);
      if (n <= 0) break;
      const take = Math.min(n, total - written);
      for (let c = 0; c < this.audio.channels; c++) out[c].set(tmp[c].subarray(0, take), written);
      written += take;
    }
    source.close();
    return { sampleRate: sr, channels: this.audio.channels, planar: out, written, expected: total };
  }

  frameAtProgram(programSeconds) {
    return this.video?.frameAt(programSeconds) ?? null;
  }

  on(type, fn) {
    this.addEventListener(type, (e) => fn(e.detail));
    return this;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  dispose() {
    clearTimeout(this._reanchorTimer);
    this._stopTicker();
    this.playing = false;
    try { this.node?.port.postMessage({ type: 'pause' }); } catch {}
    try { this.node?.disconnect(); } catch {}
    this.audio?.close();
    this.video?.close();
    if (this.ctx) {
      try { this.ctx.close(); } catch {}
    }
    this.ready = false;
  }
}
