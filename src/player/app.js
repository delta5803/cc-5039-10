import { SlowmoEngine } from '../kernel/engine.js';
import { RATE_POLICY, formatRate, resolveRate } from '../kernel/rates.js';

const $ = (id) => document.getElementById(id);

const state = {
  engine: null,
  mediaName: null,
  rate: 1,
  regionStart: 0,
  regionEnd: 4,
  loop: true,
  dragging: null,
  lastStats: null,
  audioAnalyser: null,
};

const els = {
  stage: $('stage'),
  canvas: $('frame-canvas'),
  badge: $('frame-badge'),
  playBtn: $('play-btn'),
  stepBack: $('step-back'),
  stepFwd: $('step-fwd'),
  timeline: $('timeline'),
  track: $('timeline'),
  ticks: $('timeline-ticks'),
  regionEl: $('timeline-region'),
  handleIn: $('handle-in'),
  handleOut: $('handle-out'),
  playhead: $('playhead'),
  rateSlider: $('rate-slider'),
  rateValue: $('rate-value'),
  ratePresets: $('rate-presets'),
  rateNotice: $('rate-notice'),
  fileInput: $('file-input'),
  demoRow: $('demo-row'),
  status: $('status'),
  // result panel
  outAdopted: $('out-adopted'),
  outRequested: $('out-requested'),
  outTier: $('out-tier'),
  outDeviation: $('out-deviation'),
  outDrift: $('out-drift'),
  outLatency: $('out-latency'),
  outRegion: $('out-region'),
  outLoop: $('out-loop'),
  outPosition: $('out-position'),
  outPosition2: $('out-position-2'),
  outFrame: $('out-frame'),
  outRing: $('out-ring'),
  outUnderruns: $('out-underruns'),
  outVideoBuf: $('out-video-buf'),
  outSource: $('out-source'),
  meter: $('audio-meter'),
  inPoint: $('in-point'),
  outPoint: $('out-point'),
  mediaInfo: $('media-info'),
  loopToggle: $('loop-toggle'),
  errorBox: $('error-box'),
};

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.dataset.kind = kind;
}

function showError(err) {
  if (!err) {
    els.errorBox.hidden = true;
    return;
  }
  els.errorBox.hidden = false;
  els.errorBox.textContent = err;
}

function fmtTime(t) {
  if (!Number.isFinite(t)) return '–';
  const sign = t < 0 ? '−' : '';
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return `${sign}${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function fmtMs(seconds) {
  if (!Number.isFinite(seconds)) return '–';
  return `${(seconds * 1000).toFixed(1)} ms`;
}

function fmtPpm(ppm) {
  if (!Number.isFinite(ppm)) return '–';
  const v = Math.abs(ppm) < 1 ? 0 : ppm;
  return `${v >= 0 ? '+' : ''}${v.toFixed(0)} ppm`;
}

// ---------------------------------------------------------------- loading

async function loadBufferFromUrl(url, name) {
  setStatus(`正在载入 ${name}…`);
  showError(null);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`无法读取 ${name} (${res.status})`);
  const buf = await res.arrayBuffer();
  await loadBuffer(buf, name);
}

async function loadBuffer(buf, name) {
  if (state.engine) {
    state.engine.dispose();
    state.engine = null;
  }
  state.mediaName = name;
  const engine = new SlowmoEngine();
  state.engine = engine;
  bindEngine(engine);
  try {
    await engine.load(buf, { loop: true });
  hookAudioMeter(engine);
  } catch (e) {
    showError(`载入失败：${e.message}`);
    setStatus('载入失败', 'error');
    throw e;
  }
  const info = engine.info();
  state.mediaFps = info.video?.fps ?? 30;
  state.regionStart = 0;
  state.regionEnd = info.duration;
  engine.setRegion({ start: 0, end: info.duration }, { loop: state.loop });
  state.rate = 1;
  els.rateSlider.value = String(1);
  els.rateValue.textContent = formatRate(1);
  els.mediaInfo.textContent = [
    info.video ? `${info.video.width}×${info.video.height} · ${info.video.fps.toFixed(0)} fps · ${info.video.frames} 帧 · ${info.video.codec}` : '无视频',
    info.audio ? `${info.audio.codec} · ${info.audio.sampleRate} Hz · ${info.audio.channels} ch` : '无音频',
  ].join('  |  ');
  els.inPoint.value = '0.000';
  els.outPoint.value = info.duration.toFixed(3);
  updateRegionUI();
  await engine.setRate(1);
  setStatus(`${name} 已就绪`, 'ok');
  renderStats(engine.stats());
}

function bindEngine(engine) {
  engine.on('ready', () => {
    els.playBtn.disabled = false;
  });
  engine.on('rate', (info) => {
    els.rateNotice.hidden = info.ok;
    if (!info.ok) {
      els.rateNotice.textContent = info.message;
      els.rateNotice.dataset.tone = 'reject';
    } else if (info.degraded) {
      els.rateNotice.hidden = false;
      els.rateNotice.textContent = info.message;
      els.rateNotice.dataset.tone = 'warn';
    } else {
      els.rateNotice.hidden = true;
    }
  });
  engine.on('stats', (s) => renderStats(s));
  engine.on('error', ({ error }) => {
    showError(`播放错误：${error?.message ?? error}`);
    setStatus('播放错误', 'error');
  });
  engine.frameHook = (frame, meta) => drawFrame(frame, meta);
}

// The audio graph only exists after load(), so the meter is hooked afterwards.
function hookAudioMeter(engine) {
  if (!engine.node || !engine.ctx) return;
  const analyser = engine.ctx.createAnalyser();
  analyser.fftSize = 1024;
  engine.node.connect(analyser);
  state.audioAnalyser = analyser;
  state.meterData = new Uint8Array(analyser.fftSize);
  startMeter();
}

// ---------------------------------------------------------------- rendering

const canvasCtx = els.canvas.getContext('2d', { alpha: false });

function drawFrame(frame, meta) {
  try {
    const srcW = frame.displayWidth || frame.codedWidth;
    const srcH = frame.displayHeight || frame.codedHeight;
    if (els.canvas.width !== srcW || els.canvas.height !== srcH) {
      els.canvas.width = srcW;
      els.canvas.height = srcH;
    }
    canvasCtx.drawImage(frame, 0, 0, srcW, srcH);
    els.badge.textContent = `源位置 ${meta.programTime.toFixed(3)} s · pts ${(frame.timestamp / 1e6).toFixed(3)} s`;
  } catch {
    // A frame can be closed by a concurrent seek between lookup and draw.
  }
}

function startMeter() {
  if (state.meterRunning) return;
  state.meterRunning = true;
  const ctx = els.meter.getContext('2d');
  const draw = () => {
    requestAnimationFrame(draw);
    if (!state.audioAnalyser) return;
    const data = state.meterData;
    state.audioAnalyser.getByteTimeDomainData(data);
    const w = els.meter.width;
    const h = els.meter.height;
    ctx.fillStyle = '#0b1017';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#2f80ed';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      peak = Math.max(peak, Math.abs(v));
      const x = (i / (data.length - 1)) * w;
      const y = h / 2 - v * (h / 2 - 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = peak > 0.01 ? '#7ee787' : '#6b7684';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(peak > 0.01 ? `音频输出 ${(20 * Math.log10(peak)).toFixed(0)} dBFS` : '静音', 6, 12);
  };
  draw();
}

// ---------------------------------------------------------------- stats UI

function renderStats(s) {
  if (!s) return;
  state.lastStats = s;
  // Panel
  els.outAdopted.textContent = `${formatRate(s.rate.adopted)}${s.rate.degraded ? '（降级）' : ''}`;
  els.outRequested.textContent = s.rate.requested == null ? '–' : formatRate(s.rate.requested);
  els.outTier.textContent = {
    native: '原速直通',
    guaranteed: '音质保证区',
    degraded: '音质降级',
  }[s.rate.tier] ?? s.rate.tier;
  els.outDeviation.textContent = `${(s.clock.deviationSeconds * 1000).toFixed(1)} ms`;
  els.outDeviation.dataset.tone = Math.abs(s.clock.deviationSeconds) > 0.05 ? 'warn' : 'ok';
  els.outDrift.textContent = fmtPpm(s.clock.driftPpm);
  els.outDrift.dataset.tone = Math.abs(s.clock.driftPpm) > 20000 ? 'warn' : 'ok';
  els.outLatency.textContent = [
    `设备 ${fmtMs(s.latency.base)}`,
    `输出 ${fmtMs(s.latency.output)}`,
    `算法 ${fmtMs(s.latency.algorithm)}`,
  ].join(' · ');
  els.outRegion.textContent = `${fmtTime(s.region.start)} → ${fmtTime(s.region.end)}  (${(s.region.end - s.region.start).toFixed(3)} s)`;
  els.outLoop.textContent = s.loop ? `循环中 · 第 ${s.loopIndex + 1} 遍` : '不循环';
  els.outPosition.textContent = fmtTime(s.position);
  if (els.outPosition2) els.outPosition2.textContent = fmtTime(s.position);
  els.outSource.textContent = s.positionSource === 'audio' ? '音频渲染器输出' : s.positionSource === 'clock' ? '输出时钟' : '定位';
  const fps = state.mediaFps ?? 0;
  els.outFrame.textContent = s.av.framePts == null
    ? '–'
    : `${(s.av.framePts * fps).toFixed(0)} / ${Math.round(s.programDuration * fps)}  ·  Δ ${((s.av.deltaSeconds ?? 0) * 1000).toFixed(1)} ms`;
  els.outRing.textContent = `${(s.clock.audioRingSeconds * 1000).toFixed(0)} ms`;
  els.outUnderruns.textContent = String(s.clock.audioUnderruns);
  els.outUnderruns.dataset.tone = s.clock.audioUnderruns > 0 ? 'warn' : 'ok';
  els.outVideoBuf.textContent = `${s.clock.videoFramesReady} 帧 / ${s.clock.videoAheadSeconds.toFixed(1)} s`;

  // Transport UI
  const playheadPct = s.programDuration > 0 ? (s.position / s.programDuration) * 100 : 0;
  els.playhead.style.left = `${Math.min(100, Math.max(0, playheadPct))}%`;
  els.playBtn.textContent = s.playing ? '暂停' : '播放';
  els.playBtn.dataset.playing = String(s.playing);
  if (!state.dragging) {
    // keep region UI in sync when playback wraps/seeks
  }
  if (s.rate.adopted !== state.rate) {
    state.rate = s.rate.adopted;
    els.rateSlider.value = String(s.rate.adopted);
    els.rateValue.textContent = formatRate(s.rate.adopted);
  }
}

// ---------------------------------------------------------------- region UI

function updateRegionUI() {
  const dur = state.engine?.programDuration ?? 0;
  if (!(dur > 0)) return;
  const a = (state.regionStart / dur) * 100;
  const b = (state.regionEnd / dur) * 100;
  els.regionEl.style.left = `${a}%`;
  els.regionEl.style.width = `${Math.max(0, b - a)}%`;
  els.handleIn.style.left = `${a}%`;
  els.handleOut.style.left = `${b}%`;
  els.inPoint.value = state.regionStart.toFixed(3);
  els.outPoint.value = state.regionEnd.toFixed(3);
}

function timeFromEvent(e) {
  const rect = els.track.getBoundingClientRect();
  const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
  const dur = state.engine?.programDuration ?? 0;
  return (x / rect.width) * dur;
}

function applyRegion() {
  let start = Math.min(state.regionStart, state.regionEnd);
  let end = Math.max(state.regionStart, state.regionEnd);
  if (end - start < 0.05) end = Math.min(state.engine.programDuration, start + 0.05);
  state.regionStart = start;
  state.regionEnd = end;
  state.engine.setRegion({ start, end }, { loop: state.loop });
  updateRegionUI();
}

function setupTimeline() {
  const onDown = (e) => {
    if (!state.engine) return;
    const kind = e.target.dataset.handle;
    const t = timeFromEvent(e);
    if (kind === 'in') state.dragging = 'in';
    else if (kind === 'out') state.dragging = 'out';
    else {
      // click/drag on the track selects a new region from this point
      state.dragging = 'select';
      state.dragAnchor = t;
      state.regionBefore = { start: state.regionStart, end: state.regionEnd };
      state.regionStart = t;
      state.regionEnd = t;
    }
    if (state.dragging === 'in') state.regionStart = Math.min(t, state.regionEnd - 0.05);
    if (state.dragging === 'out') state.regionEnd = Math.max(t, state.regionStart + 0.05);
    updateRegionUI();
    els.track.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!state.dragging) return;
    const t = timeFromEvent(e);
    if (state.dragging === 'in') state.regionStart = Math.min(t, state.regionEnd - 0.05);
    else if (state.dragging === 'out') state.regionEnd = Math.max(t, state.regionStart + 0.05);
    else if (state.dragging === 'select') {
      state.regionStart = Math.min(state.dragAnchor, t);
      state.regionEnd = Math.max(state.dragAnchor, t);
    }
    updateRegionUI();
  };
  const onUp = (e) => {
    if (!state.dragging) return;
    const wasSelect = state.dragging === 'select';
    state.dragging = null;
    if (wasSelect && state.regionEnd - state.regionStart < 0.05) {
      // A plain click seeks; the region stays as it was.
      state.regionStart = state.regionBefore?.start ?? state.regionStart;
      state.regionEnd = state.regionBefore?.end ?? state.regionEnd;
      updateRegionUI();
      state.engine?.seek(timeFromEvent(e));
      return;
    }
    applyRegion();
  };
  els.track.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  els.inPoint.addEventListener('change', () => {
    const v = Math.max(0, Math.min(state.engine.programDuration, Number(els.inPoint.value) || 0));
    state.regionStart = Math.min(v, state.regionEnd - 0.05);
    applyRegion();
  });
  els.outPoint.addEventListener('change', () => {
    const v = Math.max(0, Math.min(state.engine.programDuration, Number(els.outPoint.value) || 0));
    state.regionEnd = Math.max(v, state.regionStart + 0.05);
    applyRegion();
  });
}

// ---------------------------------------------------------------- controls

function setupControls() {
  els.playBtn.addEventListener('click', async () => {
    if (!state.engine) return;
    if (state.lastStats?.playing) state.engine.pause();
    else await state.engine.play();
  });

  els.stepBack.addEventListener('click', () => {
    if (!state.engine) return;
    const t = Math.max(0, state.lastStats.position - 1 / (state.mediaFps || 30));
    state.engine.seek(t);
  });
  els.stepFwd.addEventListener('click', () => {
    if (!state.engine) return;
    const t = Math.min(state.engine.programDuration, state.lastStats.position + 1 / (state.mediaFps || 30));
    state.engine.seek(t);
  });

  const requestRate = async (value) => {
    if (!state.engine) return;
    const info = await state.engine.setRate(value);
    const adopted = info.adopted ?? state.rate;
    els.rateSlider.value = String(adopted);
    els.rateValue.textContent = formatRate(adopted);
    state.rate = adopted;
  };

  els.rateSlider.addEventListener('input', () => {
    const v = Number(els.rateSlider.value);
    els.rateValue.textContent = formatRate(v);
    requestRate(v);
  });

  for (const button of els.ratePresets.querySelectorAll('button')) {
    button.addEventListener('click', () => requestRate(Number(button.dataset.rate)));
  }

  // Explicit test of range enforcement: user can type an out-of-range rate.
  els.rateValue.addEventListener('dblclick', () => {
    const raw = window.prompt('输入速率（支持 0.10–1.50）', String(state.rate));
    if (raw == null) return;
    requestRate(Number(raw));
  });

  els.loopToggle.addEventListener('change', () => {
    state.loop = els.loopToggle.checked;
    state.engine?.setLoop(state.loop);
  });

  els.fileInput.addEventListener('change', async () => {
    const file = els.fileInput.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      await loadBuffer(buf, file.name);
    } catch (e) {
      showError(`载入失败：${e.message}`);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    if (e.code === 'Space') {
      e.preventDefault();
      els.playBtn.click();
    } else if (e.code === 'ArrowLeft') {
      els.stepBack.click();
    } else if (e.code === 'ArrowRight') {
      els.stepFwd.click();
    }
  });
}

// ---------------------------------------------------------------- boot

async function listDemos() {
  try {
    const res = await fetch('/api/demos');
    if (!res.ok) return [];
    return (await res.json()).demos ?? [];
  } catch {
    return [];
  }
}

async function boot() {
  setupControls();
  setupTimeline();
  els.rateNotice.hidden = true;
  els.rateSlider.min = String(RATE_POLICY.min);
  els.rateSlider.max = String(RATE_POLICY.max);
  els.rateSlider.step = '0.05';
  $('rate-range').textContent = `${RATE_POLICY.min.toFixed(2)}× – ${RATE_POLICY.max.toFixed(2)}×（音质保证区 ${RATE_POLICY.qualityMin.toFixed(2)}×–${RATE_POLICY.qualityMax.toFixed(2)}×）`;
  els.playBtn.disabled = true;

  const demos = await listDemos();
  if (demos.length) {
    for (const demo of demos) {
      const b = document.createElement('button');
      b.className = 'demo-btn';
      b.textContent = demo.label;
      b.title = demo.description;
      b.addEventListener('click', () => loadBufferFromUrl(demo.url, demo.label).catch((e) => showError(e.message)));
      els.demoRow.appendChild(b);
    }
    try {
      await loadBufferFromUrl(demos[0].url, demos[0].label);
    } catch (e) {
      showError(`演示片段载入失败：${e.message}`);
    }
  } else {
    setStatus('请选择本地视频文件，或运行 npm run fixtures 生成演示片段', '');
    showError('未找到演示片段。可运行 `npm run fixtures` 生成，或直接选择本地 MP4。');
  }
}

boot();
