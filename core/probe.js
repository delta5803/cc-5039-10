import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const run = promisify(execFile);

// 元数据探测：优先 ffprobe（JSON），失败时回退解析 ffmpeg -i 的 stderr。
export async function probeMedia(filePath) {
  try {
    return await probeWithFfprobe(filePath);
  } catch {
    return await probeWithFfmpeg(filePath);
  }
}

function normalize({ durationSec, fps, width, height, sampleRate, channels, videoCodec, audioCodec, frameCount }) {
  return {
    durationSec,
    fps,
    width,
    height,
    sampleRate,
    channels,
    videoCodec,
    audioCodec,
    frameCount: frameCount ?? (fps && durationSec ? Math.round(fps * durationSec) : null),
  };
}

async function probeWithFfprobe(filePath) {
  const { stdout } = await run(ffprobeStatic.path, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], { maxBuffer: 16 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const video = data.streams.find((s) => s.codec_type === 'video');
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('未找到视频流');
  const [fn, fd] = (video.avg_frame_rate || video.r_frame_rate || '0/1').split('/').map(Number);
  const fps = fd ? fn / fd : Number(fn) || 0;
  return normalize({
    durationSec: Number(data.format.duration),
    fps,
    width: video.width,
    height: video.height,
    sampleRate: audio ? Number(audio.sample_rate) : null,
    channels: audio ? audio.channels : 0,
    videoCodec: video.codec_name,
    audioCodec: audio ? audio.codec_name : null,
    frameCount: video.nb_frames ? Number(video.nb_frames) : null,
  });
}

async function probeWithFfmpeg(filePath) {
  let stderr = '';
  try {
    await run(ffmpegPath, ['-hide_banner', '-i', filePath], { maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    stderr = err.stderr || '';
  }
  const duration = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  const videoLine = /Stream #.*Video:\s*(\w+).*?(\d{2,5})x(\d{2,5}).*?([\d.]+)\s*fps/.exec(stderr);
  const audioLine = /Stream #.*Audio:\s*(\w+).*?(\d+)\s*Hz.*?(\d+)\s*ch|Stream #.*Audio:\s*(\w+).*?(\d+)\s*Hz,\s*(mono|stereo)/.exec(stderr);
  if (!duration || !videoLine) throw new Error(`无法解析媒体信息: ${filePath}`);
  const [, h, m, s] = duration;
  let channels = 0, sampleRate = null, audioCodec = null;
  if (audioLine) {
    audioCodec = audioLine[1] || audioLine[4];
    sampleRate = Number(audioLine[2] || audioLine[5]);
    channels = audioLine[3] ? Number(audioLine[3]) : (audioLine[6] === 'stereo' ? 2 : 1);
  }
  return normalize({
    durationSec: Number(h) * 3600 + Number(m) * 60 + Number(s),
    fps: Number(videoLine[4]),
    width: Number(videoLine[2]),
    height: Number(videoLine[3]),
    sampleRate,
    channels,
    videoCodec: videoLine[1],
    audioCodec,
    frameCount: null,
  });
}
