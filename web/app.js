const $ = (id) => document.getElementById(id);

const state = {
  sourceId: null,
  meta: null,
  config: null,
  result: null, // {url, stats}
};

function showError(msg) {
  const box = $('error-box');
  box.hidden = !msg;
  box.textContent = msg || '';
}

function fmt(v, digits = 3) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

// 输出时间 -> 源时间（与内核 MediaClock 同构的分段映射，用于结果区实时位置换算）
function sourceTimeAt(segments, outT) {
  for (const seg of segments) {
    if (outT <= seg.outEnd) return seg.inSec + (outT - seg.outStart) * seg.rate;
  }
  const last = segments[segments.length - 1];
  return last.outSec;
}

async function init() {
  state.config = await api('/api/config');
  const { minRate, maxRate } = state.config;
  $('range-note').textContent =
    `支持速率范围 [${minRate}, ${maxRate}]：范围外请求将被拒绝；` +
    `音频采用 WSOLA 时间伸缩保持音高，视频按共同媒体时钟取帧。`;
  const rate = $('rate');
  rate.min = minRate; rate.max = maxRate;

  $('file-input').addEventListener('change', onUpload);
  $('btn-sample').addEventListener('click', onSample);
  $('btn-set-in').addEventListener('click', () => { $('in-sec').value = $('src-video').currentTime.toFixed(2); updateEstimate(); });
  $('btn-set-out').addEventListener('click', () => { $('out-sec').value = $('src-video').currentTime.toFixed(2); updateEstimate(); });
  $('in-sec').addEventListener('input', updateEstimate);
  $('out-sec').addEventListener('input', updateEstimate);
  $('rate').addEventListener('input', () => { $('rate-num').value = $('rate').value; updateEstimate(); });
  $('rate-num').addEventListener('input', () => { $('rate').value = $('rate-num').value; updateEstimate(); });
  $('btn-render').addEventListener('click', onRender);
  requestAnimationFrame(updatePosition);
}

function onSourceReady(id, meta) {
  state.sourceId = id;
  state.meta = meta;
  const v = $('src-video');
  v.src = `/api/sources/${encodeURIComponent(id)}`;
  $('src-meta').textContent =
    `${meta.width}x${meta.height} @ ${fmt(meta.fps, 2)}fps，时长 ${fmt(meta.durationSec, 2)}s，` +
    `音频 ${meta.sampleRate ? meta.sampleRate + 'Hz x' + meta.channels : '无音轨'}`;
  $('out-sec').value = meta.durationSec.toFixed(2);
  $('btn-render').disabled = false;
  updateEstimate();
}

async function onUpload() {
  const file = $('file-input').files[0];
  if (!file) return;
  showError('');
  $('upload-status').textContent = '上传中…';
  try {
    const { id, meta } = await api(`/api/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    $('upload-status').textContent = '已上传';
    onSourceReady(id, meta);
  } catch (err) {
    $('upload-status').textContent = '';
    showError(err.message);
  }
}

async function onSample() {
  showError('');
  $('upload-status').textContent = '生成中…';
  try {
    const { id, meta } = await api('/api/sample', { method: 'POST' });
    $('upload-status').textContent = '已生成合成示例（帧号色块 + 脉冲/持续音）';
    onSourceReady(id, meta);
  } catch (err) {
    $('upload-status').textContent = '';
    showError(err.message);
  }
}

function updateEstimate() {
  const inSec = Number($('in-sec').value);
  const outSec = Number($('out-sec').value);
  const rate = Number($('rate-num').value);
  if (outSec > inSec && rate > 0) {
    $('est-duration').textContent = `区间 ${fmt(outSec - inSec, 2)}s → 慢放后约 ${fmt((outSec - inSec) / rate, 2)}s`;
  } else {
    $('est-duration').textContent = '';
  }
}

async function onRender() {
  showError('');
  const payload = {
    id: state.sourceId,
    inSec: Number($('in-sec').value),
    outSec: Number($('out-sec').value),
    rate: Number($('rate-num').value),
  };
  $('btn-render').disabled = true;
  $('render-status').textContent = '提交渲染…';
  try {
    const { jobId } = await api('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      const job = await api(`/api/jobs/${jobId}`);
      if (job.status === 'done') {
        $('render-status').textContent = '完成';
        onResult(job.result);
        break;
      }
      if (job.status === 'error') throw new Error(job.error);
      const p = job.progress || {};
      $('render-status').textContent =
        p.phase === 'video'
          ? `渲染视频帧 ${p.frame}/${p.totalFrames}`
          : `处理中（${p.phase || '...'}）`;
    }
  } catch (err) {
    $('render-status').textContent = '';
    showError(err.message);
  } finally {
    $('btn-render').disabled = false;
  }
}

function onResult({ url, stats }) {
  state.result = { url, stats };
  $('result-panel').hidden = false;
  const v = $('out-video');
  v.src = url;
  v.play().catch(() => {});
  $('download-link').href = url;

  const rows = [
    ['请求速率', `${$('rate-num').value}x`],
    ['实际采用速率', stats.adoptedRates.map((r) => `${r}x`).join(' → ')],
    ['输出时钟', `${fmt(stats.outputFps, 2)} fps，共 ${stats.outputFrames} 帧，时长 ${fmt(stats.outputDurationSec, 3)}s`],
    ['实际解码速率', `${fmt(stats.decode.avgDecodeFps, 1)} 帧/s（解码 ${stats.decode.framesDecoded} 帧）`],
    ['缓冲水位', `高水位 ${stats.decode.highWaterFrames} 帧，峰值队列 ${stats.decode.maxQueueSeen} 帧`],
  ];
  if (stats.audio) {
    rows.push(
      ['WSOLA 固定延迟(已补偿)', `${fmt(stats.sync.compensatedFixedLatencySec * 1000, 2)} ms（窗长 ${stats.audio.params.windowSamples} 样本）`],
      ['音频时钟抖动 RMS/最大', `${fmt(stats.sync.audioJitterRmsSec * 1000, 2)} / ${fmt(stats.sync.audioJitterMaxAbsSec * 1000, 2)} ms`],
      ['视频取帧误差 RMS/最大', `${fmt(stats.sync.videoPickErrorRmsSec * 1000, 2)} / ${fmt(stats.sync.videoPickErrorMaxAbsSec * 1000, 2)} ms`],
      ['容器音/视时长差', `${fmt((stats.sync.containerAvDurationDiffSec || 0) * 1000, 1)} ms`],
    );
  } else {
    rows.push(['音频', '源视频无音轨（如实标注，未以静音规避同步核对）']);
  }
  $('stats-table').innerHTML =
    rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
}

function updatePosition() {
  requestAnimationFrame(updatePosition);
  if (!state.result) return;
  const v = $('out-video');
  const stats = state.result.stats;
  if (!v.duration) return;
  const t = v.currentTime;
  const frame = Math.floor(t * stats.outputFps);
  const srcT = sourceTimeAt(stats.segments, t);
  $('pos-text').textContent =
    `播放位置: 输出 ${fmt(t, 2)}s / ${fmt(v.duration, 2)}s（第 ${frame} 帧）→ 源时间 ${fmt(srcT, 2)}s`;
  $('pos-bar').style.width = `${(t / v.duration) * 100}%`;
}

init().catch((err) => showError(err.message));
