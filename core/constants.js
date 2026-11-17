// 全局常量：支持的变速范围与内核默认参数。
// 超出 [MIN_RATE, MAX_RATE] 的请求一律拒绝（见 validate.js），不宣称任意倍率无失真。

export const MIN_RATE = 0.25; // 最慢 1/4 速度
export const MAX_RATE = 2.0;  // 最快 2 倍（慢放工具，兼顾小幅快进定位）

export const AUDIO_SAMPLE_RATE = 44100;
export const AUDIO_CHANNELS = 2;

// WSOLA 参数（在 44.1kHz 下）：窗长 ~23ms，合成步长 = 窗长/4
export const WSOLA_WINDOW_MS = 23;
export const WSOLA_OVERLAP_RATIO = 4;       // 窗长 / 合成步长
export const WSOLA_MAX_DEVIATION_MS = 12;   // 相关搜索半径，限制音频时钟抖动上界

// 解码缓冲：以“源帧”为单位，水位随消耗速率（=播放速率）动态调整
export const BUFFER_LOOKAHEAD_SEC = 0.75;   // 输出时间轴上的预读窗口
export const BUFFER_MIN_FRAMES = 8;

export const DEFAULT_OUTPUT_FPS = 0; // 0 = 跟随源帧率
