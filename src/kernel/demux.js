import * as MP4Box from 'mp4box';

const MICROS = 1e6;

function firstSampleEntry(trak) {
  const stsd = trak?.mdia?.minf?.stbl?.stsd;
  return stsd?.entries?.[0] ?? null;
}

function avcDescription(trak) {
  const entry = firstSampleEntry(trak);
  const box = entry?.avcC ?? entry?.hvcC;
  if (!box) return null;
  const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
  box.write(stream);
  // The box serialises with an 8-byte header; WebCodecs wants the record only.
  return new Uint8Array(stream.buffer).slice(8);
}

function aacDescription(trak) {
  const entry = firstSampleEntry(trak);
  const esds = entry?.esds ?? entry?.wave?.esds;
  const dcd = esds?.esd?.descs?.find((d) => d && d.oti !== undefined);
  const dsi = dcd?.descs?.find((d) => d && d.data);
  return dsi ? new Uint8Array(dsi.data) : null;
}

function editOffsetSeconds(trak) {
  const entries = trak?.edts?.elst?.entries;
  if (!entries || entries.length === 0) return 0;
  const mediaTime = entries[0].media_time;
  if (mediaTime === undefined || mediaTime < 0) return 0;
  return mediaTime / trak.mdia.mdhd.timescale;
}

function lastEnd(samples) {
  let end = 0;
  for (const s of samples) end = Math.max(end, s.pts + s.duration);
  return end;
}

export async function demuxMp4(arrayBuffer) {
  const file = MP4Box.createFile();
  const collected = { video: [], audio: [] };
  let videoTrackId = null;
  let audioTrackId = null;

  const info = await new Promise((resolve, reject) => {
    file.onError = (e) => reject(new Error(`mp4 parse failed: ${e}`));
    file.onReady = (i) => {
      for (const t of i.tracks) {
        if (t.type === 'video' && videoTrackId === null) videoTrackId = t.id;
        if (t.type === 'audio' && audioTrackId === null) audioTrackId = t.id;
      }
      file.onSamples = (id, _user, batch) => {
        const kind = id === videoTrackId ? 'video' : id === audioTrackId ? 'audio' : null;
        if (kind) for (const s of batch) collected[kind].push(s);
      };
      if (audioTrackId !== null) file.setExtractionOptions(audioTrackId, null, { nbSamples: 1e9 });
      if (videoTrackId !== null) file.setExtractionOptions(videoTrackId, null, { nbSamples: 1e9 });
      file.start();
      resolve(i);
    };
    const buf = arrayBuffer.slice(0);
    buf.fileStart = 0;
    file.appendBuffer(buf);
    file.flush();
  });

  await new Promise((r) => setTimeout(r, 0));

  const result = { duration: info.duration / info.timescale, tracks: {} };

  const buildTrack = (trackInfo, kind) => {
    if (!trackInfo) return null;
    const trak = file.getTrackById(trackInfo.id);
    const timescale = trackInfo.timescale;
    // Shift every timestamp by the edit offset so program 0 is the first
    // presented video frame and the first audible audio sample.
    const shift = editOffsetSeconds(trak);
    const list = collected[kind]
      .map((s) => ({
        kind,
        pts: s.cts / timescale - shift,
        dts: s.dts / timescale - shift,
        duration: s.duration / timescale,
        isKey: !!s.is_sync,
        data: s.data,
      }))
      .sort((a, b) => a.dts - b.dts);

    if (kind === 'audio') {
      return {
        kind,
        codec: trackInfo.codec,
        timescale,
        sampleRate: trackInfo.audio?.sample_rate ?? 48000,
        channels: trackInfo.audio?.channel_count ?? 1,
        description: aacDescription(trak),
        samples: list,
        // Decoded frames before this program time are codec priming: they must
        // be decoded to keep MDCT state valid but are not presented.
        primingSeconds: Math.max(0, shift),
        startOffset: shift,
      };
    }
    return {
      kind,
      codec: trackInfo.codec,
      timescale,
      width: trackInfo.video?.width ?? 0,
      height: trackInfo.video?.height ?? 0,
      description: avcDescription(trak),
      samples: list,
      startOffset: shift,
    };
  };

  const videoInfo = info.tracks.find((t) => t.type === 'video');
  const audioInfo = info.tracks.find((t) => t.type === 'audio');
  if (videoInfo) result.tracks.video = buildTrack(videoInfo, 'video');
  if (audioInfo) result.tracks.audio = buildTrack(audioInfo, 'audio');

  result.duration = Math.max(
    result.tracks.video ? lastEnd(result.tracks.video.samples) : 0,
    result.tracks.audio ? lastEnd(result.tracks.audio.samples) : 0,
  );
  return result;
}
