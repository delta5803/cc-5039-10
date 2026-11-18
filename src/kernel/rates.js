export const RATE_MIN = 0.1;
export const RATE_MAX = 1.5;
export const QUALITY_MIN = 0.25;
export const QUALITY_MAX = 1.25;

export const RATE_POLICY = Object.freeze({
  min: RATE_MIN,
  max: RATE_MAX,
  qualityMin: QUALITY_MIN,
  qualityMax: QUALITY_MAX,
  summary: '支持 0.10×–1.50×；0.25×–1.25× 为音质保证区；超出范围拒绝。',
});

const round3 = (v) => Math.round(v * 1000) / 1000;

export function resolveRate(value) {
  const raw = typeof value === 'string' ? value.trim() : value;
  const requested = raw === '' || raw == null ? NaN : Number(raw);
  if (!Number.isFinite(requested)) {
    return {
      ok: false,
      rejected: true,
      requested: value,
      code: 'NOT_A_NUMBER',
      message: '速率必须是数字。',
    };
  }
  if (requested < RATE_MIN || requested > RATE_MAX) {
    return {
      ok: false,
      rejected: true,
      requested,
      code: 'OUT_OF_RANGE',
      min: RATE_MIN,
      max: RATE_MAX,
      message: `速率 ${requested}× 超出支持范围 ${RATE_MIN.toFixed(2)}×–${RATE_MAX.toFixed(2)}×，已拒绝。`,
    };
  }
  const adopted = round3(requested);
  if (adopted === 1) {
    return {
      ok: true,
      rejected: false,
      requested,
      adopted,
      tier: 'native',
      degraded: false,
      message: '原速播放，音频直通。',
    };
  }
  const inQuality = adopted >= QUALITY_MIN && adopted <= QUALITY_MAX;
  if (!inQuality) {
    return {
      ok: true,
      rejected: false,
      requested,
      adopted,
      tier: 'degraded',
      degraded: true,
      message:
        adopted < QUALITY_MIN
          ? `已采用 ${adopted}×：低于 ${QUALITY_MIN}×，WSOLA 重复段增大，音质降级。`
          : `已采用 ${adopted}×：高于 ${QUALITY_MAX}×，WSOLA 压缩段增大，音质降级。`,
    };
  }
  return {
    ok: true,
    rejected: false,
    requested,
    adopted,
    tier: 'guaranteed',
    degraded: false,
    message: `已采用 ${adopted}×，位于音质保证区。`,
  };
}

export function formatRate(rate) {
  return `${Number(rate).toFixed(2)}×`;
}
