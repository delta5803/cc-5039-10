import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

// MP4 编码器：视频从 stdin 以 rawvideo 逐帧写入，音频从临时 PCM 文件读入。
// 输出时钟 = 帧序号 / 输出帧率，由容器 PTS 确定，与墙钟、解码速度无关。
export class Mp4Encoder {
  constructor(outputPath, { width, height, fps, sampleRate, channels, audioPcmPath }) {
    this.outputPath = outputPath;
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.audioPcmPath = audioPcmPath;
    this.framesWritten = 0;
  }

  start() {
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      '-s', `${this.width}x${this.height}`,
      '-r', String(this.fps),
      '-i', 'pipe:0',
    ];
    if (this.audioPcmPath) {
      args.push(
        '-f', 'f32le', '-ar', String(this.sampleRate), '-ac', String(this.channels),
        '-i', this.audioPcmPath,
      );
    }
    args.push(
      '-map', '0:v',
      ...(this.audioPcmPath ? ['-map', '1:a'] : []),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '18',
      ...(this.audioPcmPath ? ['-c:a', 'aac', '-b:a', '160k'] : []),
      '-movflags', '+faststart',
      this.outputPath,
    );
    this.proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this._stderr = '';
    this._stdinError = null;
    this.proc.stdin.on('error', (err) => { this._stdinError = err; });
    this.proc.stderr.on('data', (c) => { this._stderr += c.toString('utf8'); });
    this._closed = new Promise((resolve, reject) => {
      this.proc.on('error', reject);
      this.proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`编码失败(code=${code}): ${this._stderr.slice(-800)}`));
        } else {
          resolve();
        }
      });
    });
  }

  // 写入一帧（遵循背压）
  async writeFrame(frameBuf) {
    if (!this.proc) this.start();
    if (this._stdinError) throw this._stdinError;
    this.framesWritten++;
    if (!this.proc.stdin.write(frameBuf)) {
      await new Promise((resolve) => this.proc.stdin.once('drain', resolve));
      if (this._stdinError) throw this._stdinError;
    }
  }

  async finish() {
    if (!this.proc) this.start();
    this.proc.stdin.end();
    await this._closed;
    return { framesWritten: this.framesWritten, outputPath: this.outputPath };
  }
}
