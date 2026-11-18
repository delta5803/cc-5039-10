// WSOLA (Waveform Similarity Overlap-Add) time-stretch.
// Changes duration without resampling, so pitch is preserved.
// Planar channel API; one segmentation offset is shared by all channels
// so the stereo image does not wander.

const EPS = 1e-9;

function growFloat32(old, needed) {
  if (old.length >= needed) return old;
  let size = old.length || 1024;
  while (size < needed) size *= 2;
  const next = new Float32Array(size);
  next.set(old);
  return next;
}

export class Wsola {
  constructor({
    sampleRate,
    channels = 2,
    frameSeconds = 0.03,
    searchSeconds = 0.006,
    analysisSeconds = 0.008,
  }) {
    if (!(sampleRate > 0)) throw new Error('sampleRate required');
    this.sampleRate = sampleRate;
    this.channels = Math.max(1, channels | 0);
    let frame = Math.round(frameSeconds * sampleRate);
    frame -= frame % 2;
    this.frameLen = Math.max(64, frame);
    this.hop = this.frameLen / 2; // output samples per frame
    this.overlap = this.hop;
    this.search = Math.max(1, Math.round(searchSeconds * sampleRate));
    this.analysis = Math.min(
      this.overlap,
      Math.max(8, Math.round(analysisSeconds * sampleRate)),
    );
    this.rate = 1;
    this.reset(0);
  }

  // inputProgramSample is the source position that output sample 0 represents.
  reset(inputProgramSample = 0) {
    this.inBuf = Array.from({ length: this.channels }, () => new Float32Array(4096));
    this.inLen = 0; // valid samples in inBuf
    this.inBase = 0; // absolute source index of inBuf[0]
    this.nominal = Math.max(0, Math.round(inputProgramSample)); // absolute source index of next frame
    this.prevStart = null; // absolute source index of previous chosen frame
    this.tail = null; // previous frame's second half, Float32Array per channel
    this.tailStart = null;
    this.frames = 0;
    this.outBuf = Array.from({ length: this.channels }, () => new Float32Array(0));
    this.outLen = 0;
    this.outBase = 0; // absolute output sample index of outBuf[0]
    this.outGenerated = 0; // total output samples generated
    this.underrun = false;
    this.starvedFrames = 0;
    this.ended = false;
    this.padLen = 0;
  }

  setRate(rate) {
    if (!(rate > 0)) throw new Error('rate must be positive');
    this.rate = rate;
  }

  get lookaheadSeconds() {
    return this.frameLen / this.sampleRate;
  }

  get lookaheadOutputSamples() {
    return Math.ceil(this.frameLen / this.rate);
  }

  // Append a block of planar input. `startSample` is the absolute source index
  // of the first sample; blocks may be appended in any order as long as they
  // are contiguous with what is already buffered.
  push(planar, startSample = this.inBase + this.inLen) {
    const n = planar[0].length;
    if (this.inLen === 0) {
      // First block after a reset may start later than the reset position
      // (e.g. an offline render from t=1 while the instance was reset at 0).
      // Re-base the nominal read head so the search window stays reachable.
      this.inBase = startSample;
      this.nominal = Math.max(this.nominal, startSample);
    }
    if (startSample !== this.inBase + this.inLen) {
      throw new Error('non-contiguous wsola input');
    }
    for (let c = 0; c < this.channels; c++) {
      const src = planar[c] ?? planar[0];
      const needed = this.inLen + n;
      this.inBuf[c] = growFloat32(this.inBuf[c], needed);
      this.inBuf[c].set(src.subarray(0, n), this.inLen);
    }
    this.inLen += n;
  }

  get inputEnd() {
    return this.inBase + this.inLen - this.padLen;
  }

  // Signal that no more input will arrive. Pads the source with silence so the
  // final lookahead frame can be produced, and lets render() drain completely.
  endOfInput() {
    if (this.ended) return;
    this.ended = true;
    const pad = this.frameLen + this.search * 2 +
      Math.ceil((this.frameLen + this.search) / Math.max(this.rate, 1e-3)) + 8;
    for (let c = 0; c < this.channels; c++) {
      const needed = this.inLen + pad;
      this.inBuf[c] = growFloat32(this.inBuf[c], needed);
      this.inBuf[c].fill(0, this.inLen, needed);
    }
    this.padLen = pad;
    this.inLen += pad;
  }

  // Absolute source index currently being consumed (for buffer metrics).
  get consumedInputSample() {
    return Math.round(this.nominal);
  }

  _compactInput() {
    const keepFrom = Math.max(this.inBase, Math.floor(this.nominal) - this.search - 2);
    if (keepFrom - this.inBase < 4096) return;
    const drop = keepFrom - this.inBase;
    for (let c = 0; c < this.channels; c++) {
      this.inBuf[c].copyWithin(0, drop, this.inLen);
    }
    this.inBase += drop;
    this.inLen -= drop;
    if (this.prevStart !== null) this.prevStart -= drop;
    if (this.tailStart !== null) this.tailStart -= drop;
  }

  _canGenerate() {
    const nominal = Math.round(this.nominal);
    return nominal + this.search + this.frameLen <= this.inBase + this.inLen;
  }

  _score(candidate, tail, tailEnergy) {
    const an = this.analysis;
    let dot = 0;
    let energy = 0;
    for (let c = 0; c < this.channels; c++) {
      const src = this.inBuf[c];
      const base = candidate - this.inBase;
      const t = tail[c];
      for (let i = 0; i < an; i++) {
        const v = src[base + i];
        dot += t[i] * v;
        energy += v * v;
      }
    }
    if (energy < EPS || tailEnergy < EPS) return 0;
    return dot / Math.sqrt(energy * tailEnergy);
  }

  _findBestOffset() {
    const nominal = Math.round(this.nominal);
    const minStart = this.inBase;
    const maxStart = this.inBase + this.inLen - this.frameLen;
    const lo = Math.max(minStart, nominal - this.search);
    const hi = Math.min(maxStart, nominal + this.search);
    if (hi < lo) return null;
    if (!this.tail) return Math.max(lo, Math.min(hi, nominal));
    const tail = this.tail;
    let tailEnergy = 0;
    for (let c = 0; c < this.channels; c++) {
      const t = tail[c];
      for (let i = 0; i < this.analysis; i++) tailEnergy += t[i] * t[i];
    }
    if (tailEnergy < EPS) return Math.max(lo, Math.min(hi, nominal));

    const stride = Math.max(1, Math.round((hi - lo) / 48) || 1);
    let best = nominal;
    let bestScore = -Infinity;
    for (let cand = lo; cand <= hi; cand += stride) {
      const s = this._score(cand, tail, tailEnergy);
      const bias = 1 - Math.abs(cand - nominal) / (this.search * 8);
      if (s + bias * 0.02 > bestScore) {
        bestScore = s + bias * 0.02;
        best = cand;
      }
    }
    const fineLo = Math.max(lo, best - stride);
    const fineHi = Math.min(hi, best + stride);
    for (let cand = fineLo; cand <= fineHi; cand++) {
      const s = this._score(cand, tail, tailEnergy);
      if (s > bestScore) {
        bestScore = s;
        best = cand;
      }
    }
    return best;
  }

  _generateFrame() {
    if (!this._canGenerate()) return false;
    const start = this._findBestOffset();
    if (start === null) return false;
    const N = this.frameLen;
    const K = this.hop;
    const startIdx = start - this.inBase;

    this._ensureOut(this.outLen + K);
    const fadeIn = this._fadeIn ?? (this._fadeIn = new Float32Array(K));
    const fadeOut = this._fadeOut ?? (this._fadeOut = new Float32Array(K));
    if (!this._fadeReady) {
      for (let i = 0; i < K; i++) {
        const w = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / K);
        fadeIn[i] = w;
        fadeOut[i] = 1 - w;
      }
      this._fadeReady = true;
    }

    for (let c = 0; c < this.channels; c++) {
      const src = this.inBuf[c];
      const dst = this.outBuf[c];
      if (this.frames === 0 || !this.tail) {
        for (let i = 0; i < K; i++) dst[this.outLen + i] = src[startIdx + i];
      } else {
        const t = this.tail[c];
        for (let i = 0; i < K; i++) {
          dst[this.outLen + i] = fadeOut[i] * t[i] + fadeIn[i] * src[startIdx + i];
        }
      }
    }

    // Save this frame's second half as the next frame's continuation target.
    const nextTail = Array.from({ length: this.channels }, (_, c) =>
      this.inBuf[c].slice(startIdx + K, startIdx + N),
    );
    this.tail = nextTail;
    this.tailStart = start + K;
    this.prevStart = start;
    this.frames += 1;
    this.outLen += K;
    this.nominal += K * this.rate;

    this._compactInput();
    return true;
  }

  _ensureOut(needed) {
    for (let c = 0; c < this.channels; c++) {
      if (this.outBuf[c].length < needed) {
        const next = new Float32Array(Math.max(needed, this.outBuf[c].length * 2, 4096));
        next.set(this.outBuf[c].subarray(0, this.outLen));
        this.outBuf[c] = next;
      }
    }
  }

  // Fill planarOut (array of Float32Array, all same length) with stretched audio.
  // Returns the number of samples written; < planarOut[0].length means starvation.
  render(planarOut) {
    const want = planarOut[0].length;
    this.underrun = false;
    while (this.outLen < want) {
      if (!this._generateFrame()) {
        if (this.ended) break;
        this.underrun = true;
        this.starvedFrames += 1;
        break;
      }
    }
    const n = Math.min(want, this.outLen);
    for (let c = 0; c < this.channels; c++) {
      const out = planarOut[c] ?? planarOut[0];
      out.set(this.outBuf[c].subarray(0, n), 0);
      if (n < want) out.fill(0, n);
    }
    if (n > 0) {
      for (let c = 0; c < this.channels; c++) {
        this.outBuf[c].copyWithin(0, n, this.outLen);
      }
      this.outLen -= n;
      this.outBase += n;
      this.outGenerated += n;
    }
    return n;
  }

  // Convenience offline API used by tests and the CLI.
  // `inputLength` bounds the source so trailing lookahead is not stretched.
  static stretch(planar, { sampleRate, rate, frameSeconds, searchSeconds, inputLength }) {
    const wsola = new Wsola({ sampleRate, channels: planar.length, frameSeconds, searchSeconds });
    wsola.setRate(rate);
    wsola.push(planar, 0);
    wsola.endOfInput();
    const sourceLen = inputLength ?? planar[0].length;
    const outLen = Math.round(sourceLen / rate);
    const out = planar.map(() => new Float32Array(outLen + wsola.hop));
    let written = 0;
    const block = 1024;
    const tmp = planar.map(() => new Float32Array(block));
    while (written < outLen) {
      const n = wsola.render(tmp);
      if (n === 0) break;
      const take = Math.min(n, outLen - written);
      for (let c = 0; c < planar.length; c++) out[c].set(tmp[c].subarray(0, take), written);
      written += take;
    }
    return out.map((ch) => ch.subarray(0, Math.min(written, outLen)));
  }
}
