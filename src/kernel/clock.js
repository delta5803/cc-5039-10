// Shared media clock.
//
// Maps output-clock time to program (source) time for every frame the player
// emits. Playback speed is *not* applied by stretching timer intervals: the
// clock advances at real time, and rate is a slope that maps output seconds to
// program seconds. Video and audio consumers both read this one clock.

export class MediaClock {
  // programAnchor / outputAnchor are in seconds. For rate r:
  //   program(t) = programAnchor + (t - outputAnchor) * r
  constructor({ rate = 1, programAnchor = 0, outputAnchor = 0 } = {}) {
    this.rate = rate;
    this.programAnchor = programAnchor;
    this.outputAnchor = outputAnchor;
    this.pausedAt = null;
  }

  now(outputTime) {
    return this.programAnchor + (this.at(outputTime) - this.outputAnchor) * this.rate;
  }

  at(outputTime) {
    return this.pausedAt ?? outputTime;
  }

  pause(outputTime) {
    if (this.pausedAt === null) this.pausedAt = outputTime;
  }

  resume(outputTime) {
    if (this.pausedAt !== null) {
      // Re-anchor so the program position does not jump by the pause duration.
      this.programAnchor = this.now(outputTime);
      this.outputAnchor = outputTime;
      this.pausedAt = null;
    }
  }

  get paused() {
    return this.pausedAt !== null;
  }

  // Change rate without moving program time. Takes effect immediately.
  setRate(rate, outputTime) {
    const p = this.now(outputTime);
    this.rate = rate;
    this.programAnchor = p;
    this.outputAnchor = this.at(outputTime);
  }

  seek(programTime, outputTime) {
    this.programAnchor = programTime;
    this.outputAnchor = this.at(outputTime);
  }

  // Output-clock time at which the clock's program position reaches `programTime`.
  outputTimeFor(programTime) {
    return this.outputAnchor + (programTime - this.programAnchor) / this.rate;
  }
}

// Expands a selected region into a looping program timeline.
// Positions in this module are *virtual*: v = 0 is the region start, and each
// completed pass of the region adds its full span. `locate` maps virtual time
// to the concrete source position and pass index.
export class LoopTimeline {
  constructor({ start, end, repeat = true }) {
    if (!(end > start)) throw new Error('region end must be after start');
    this.start = start;
    this.end = end;
    this.repeat = repeat;
  }

  get duration() {
    return this.end - this.start;
  }

  // virtual position -> { loopIndex, position } where position is in [start,end).
  locate(virtual) {
    const span = this.duration;
    if (!(span > 0)) return { loopIndex: 0, position: this.start };
    const v = Math.max(0, virtual);
    const loopIndex = Math.floor(v / span);
    const position = this.start + (v - loopIndex * span);
    if (!this.repeat && loopIndex > 0) return { loopIndex: 0, position: this.end };
    return { loopIndex, position };
  }

  // Concrete source position -> virtual position, for display and seeking.
  virtualFor(position) {
    const span = this.duration;
    if (!(span > 0)) return 0;
    return Math.max(0, Math.min(span, position - this.start));
  }
}
