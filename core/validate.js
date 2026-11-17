import { MIN_RATE, MAX_RATE } from './constants.js';

export class ValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

// 速率校验：超限直接拒绝，不做静默夹取，也不承诺范围外保真。
export function validateRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new ValidationError(`速率必须是有限数字，收到: ${rate}`);
  }
  if (rate < MIN_RATE || rate > MAX_RATE) {
    throw new ValidationError(
      `速率 ${rate} 超出支持范围 [${MIN_RATE}, ${MAX_RATE}]，已拒绝。` +
      `范围外的变速不做质量承诺，请改用范围内取值。`,
      { rate, min: MIN_RATE, max: MAX_RATE }
    );
  }
  return rate;
}

// 区间校验：圈定的入点/出点必须落在片长内且长度为正
export function validateRange(inSec, outSec, durationSec) {
  for (const [name, v] of [['入点', inSec], ['出点', outSec]]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new ValidationError(`${name}必须是有限数字，收到: ${v}`);
    }
  }
  if (inSec < 0 || outSec > durationSec || inSec >= outSec) {
    throw new ValidationError(
      `区间 [${inSec}, ${outSec}] 非法：需满足 0 <= 入点 < 出点 <= 片长 ${durationSec.toFixed(3)}s`,
      { inSec, outSec, durationSec }
    );
  }
  return { inSec, outSec };
}

// 分段速率表校验（内核支持区间内的速率切换）
export function validateSegments(segments, durationSec) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new ValidationError('分段表为空');
  }
  let cursor = null;
  for (const seg of segments) {
    validateRate(seg.rate);
    validateRange(seg.inSec, seg.outSec, durationSec);
    if (cursor !== null && Math.abs(seg.inSec - cursor) > 1e-6) {
      throw new ValidationError(`分段必须首尾相接：上一段出点 ${cursor}，下一段入点 ${seg.inSec}`);
    }
    cursor = seg.outSec;
  }
  return segments;
}
