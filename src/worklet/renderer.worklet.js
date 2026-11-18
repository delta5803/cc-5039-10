// Audio renderer for the slow-motion kernel.
//
// The renderer owns the authoritative output playhead: it reports how many
// output frames it has actually rendered since the first audible sample. The
// engine maps that count back to program time, so "where we are" is always
// derived from audio that really reached the output, not from a timer.
//
// Playback only starts once the ring has data, so starting on silence cannot
// run the media clock ahead of the sound. If the ring runs dry mid-play that is
// counted and reported as an underrun; it is never hidden.

const RATE_MIN = 0.05;
const RATE_MAX = 4;

class SlowmoRenderer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions ?? {};
    this.rate = opts.rate ?? 1;
    this.reportEvery = opts.reportEvery ?? 2048;
    this.channels = Math.max(1, opts.channels ?? 2);
    this.minStartSeconds = opts.minStartSeconds ?? 0.05;
    this.ringL = new Float32Array(0);
    this.ringR = new Float32Array(0);
    this.ringLen = 0;
    this.ringCap = 0;
    this.ringStart = 0;
    this.ringEnd = 0;

    this.playing = false;
    this.started = false;
    this.startedAtContext = null;
    this.consumed = 0;
    this.underflows = 0;
    this.underflowNow = false;
    this.framesSinceReport = 0;
    this.expectedFrames = 0; // output frames offered to process() while started
    this.reports = 0;
    this.port.onmessage = (e) => this._onMessage(e.data);
    this.port.postMessage({ type: 'ready', channels: this.channels, sampleRate });
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'audio': {
        const l = msg.left;
        const r = msg.right ?? msg.left;
        this._append(l, r);
        break;
      }
      case 'setRate':
        if (msg.rate >= RATE_MIN && msg.rate <= RATE_MAX) this.rate = msg.rate;
        break;
      case 'play':
        this.playing = true;
        this.started = false;
        this.startedAtContext = null;
        this.underflowNow = false;
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'flush':
        this.ringLen = 0;
        this.ringStart = 0;
        this.ringEnd = 0;
        this.underflows = 0;
        this.underflowNow = false;
        this.playing = false;
        this.started = false;
        this.startedAtContext = null;
        this.consumed = 0;
        this.expectedFrames = 0;
        break;
      case 'setLead':
        this.minStartSeconds = Math.max(0.01, Math.min(0.5, msg.minStartSeconds));
        break;
      case 'stats':
        this._report();
        break;
      default:
        break;
    }
  }

  _append(l, r) {
    const n = l.length;
    this._ensureCapacity(this.ringLen + n);
    const cap = this.ringCap;
    for (let i = 0; i < n; i++) {
      this.ringL[(this.ringEnd + i) % cap] = l[i];
      this.ringR[(this.ringEnd + i) % cap] = r[i] ?? l[i];
    }
    this.ringEnd = (this.ringEnd + n) % cap;
    this.ringLen += n;
  }

  _ensureCapacity(needed) {
    if (needed <= this.ringCap) return;
    let size = Math.max(1024, this.ringCap || 1024);
    while (size < needed) size *= 2;
    const nextL = new Float32Array(size);
    const nextR = new Float32Array(size);
    const n = this.ringLen;
    const cap = this.ringCap;
    const start = this.ringStart;
    for (let i = 0; i < n; i++) {
      nextL[i] = this.ringL[(start + i) % cap];
      nextR[i] = this.ringR[(start + i) % cap];
    }
    this.ringL = nextL;
    this.ringR = nextR;
    this.ringCap = size;
    this.ringStart = 0;
    this.ringEnd = n % size;
  }

  _report() {
    this.reports++;
    this.port.postMessage({
      type: 'stats',
      playing: this.playing,
      started: this.started,
      consumed: this.consumed,
      expectedFrames: this.expectedFrames,
      buffered: this.ringLen,
      bufferedSeconds: this.ringLen / sampleRate,
      underflows: this.underflows,
      underflowNow: this.underflowNow,
      rate: this.rate,
      currentTime,
      currentFrame,
      sampleRate,
      startedAtContext: this.startedAtContext,
    });
    this.framesSinceReport = 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const count = out[0].length;
    const left = out[0];
    const right = out[1] ?? out[0];

    if (!this.playing) {
      left.fill(0);
      if (out.length > 1) right.fill(0);
      return true;
    }

    if (!this.started) {
      const need = Math.round(this.minStartSeconds * sampleRate);
      if (this.ringLen < need) {
        // Wait for real audio; report silence so the engine keeps the clock.
        left.fill(0);
        if (out.length > 1) right.fill(0);
        this.underflowNow = true;
        this.framesSinceReport += count;
        if (this.framesSinceReport >= this.reportEvery) this._report();
        return true;
      }
      this.started = true;
      this.startedAtContext = currentTime;
      this.underflowNow = false;
    }

    this.expectedFrames += count;
    if (this.ringLen >= count) {
      const cap = this.ringCap;
      const start = this.ringStart;
      for (let i = 0; i < count; i++) {
        left[i] = this.ringL[(start + i) % cap];
        right[i] = this.ringR[(start + i) % cap];
      }
      this.ringStart = (start + count) % cap;
      this.ringLen -= count;
      this.consumed += count;
      this.underflowNow = false;
    } else {
      const cap = this.ringCap;
      const start = this.ringStart;
      for (let i = 0; i < this.ringLen; i++) {
        left[i] = this.ringL[(start + i) % cap];
        right[i] = this.ringR[(start + i) % cap];
      }
      for (let i = this.ringLen; i < count; i++) {
        left[i] = 0;
        right[i] = 0;
      }
      this.ringStart = 0;
      this.ringEnd = 0;
      this.ringLen = 0;
      this.consumed += count;
      this.underflows++;
      this.underflowNow = true;
    }

    this.framesSinceReport += count;
    if (this.framesSinceReport >= this.reportEvery) this._report();
    return true;
  }
}

registerProcessor('slowmo-renderer', SlowmoRenderer);
