import http from 'node:http';
import { promises as fs, createWriteStream, createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { probeMedia } from '../core/probe.js';
import { renderClip } from '../core/engine.js';
import { generateSampleMedia } from '../test/genmedia.js';
import { MIN_RATE, MAX_RATE } from '../core/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const UPLOADS = path.join(ROOT, 'data', 'uploads');
const RESULTS = path.join(ROOT, 'data', 'results');

const PORT = Number(process.env.PORT || 8321);

const jobs = new Map(); // jobId -> {status, progress, result, error}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp4': 'video/mp4',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': MIME['.json'] });
  res.end(body);
}

// 支持 Range 的文件流（浏览器视频拖动/循环播放需要）
async function sendFile(res, req, filePath, contentType) {
  const stat = await fs.stat(filePath);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (!m || (!m[1] && m[2])) { // "bytes=-N" 后缀形式
      start = Math.max(0, stat.size - Number(m[2]));
      end = stat.size - 1;
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': stat.size,
    });
    createReadStream(filePath).pipe(res);
  }
}

function safeName(name) {
  const base = path.basename(String(name || 'video'));
  return base.replace(/[^\w.一-龥-]/g, '_').slice(-80) || 'video';
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // ---- 静态页面 ----
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return sendFile(res, req, path.join(WEB, 'index.html'), MIME['.html']);
    }
    if (req.method === 'GET' && (url.pathname === '/app.js' || url.pathname === '/style.css')) {
      return sendFile(res, req, path.join(WEB, url.pathname), MIME[path.extname(url.pathname)]);
    }

    // ---- 配置：把内核真实支持的范围告诉界面 ----
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return sendJson(res, 200, { minRate: MIN_RATE, maxRate: MAX_RATE });
    }

    // ---- 上传源视频 ----
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const id = `${crypto.randomUUID()}-${safeName(url.searchParams.get('filename'))}`;
      const filePath = path.join(UPLOADS, id);
      await fs.mkdir(UPLOADS, { recursive: true });
      const ws = createWriteStream(filePath);
      req.pipe(ws);
      await new Promise((resolve, reject) => {
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });
      try {
        const meta = await probeMedia(filePath);
        return sendJson(res, 200, { id, meta });
      } catch (err) {
        await fs.rm(filePath, { force: true });
        return sendJson(res, 400, { error: `无法识别该文件为可解码视频: ${err.message}` });
      }
    }

    // ---- 生成合成示例视频（真实生成媒体，非固定数据冒充） ----
    if (req.method === 'POST' && url.pathname === '/api/sample') {
      const id = `${crypto.randomUUID()}-sample.mp4`;
      const filePath = path.join(UPLOADS, id);
      await fs.mkdir(UPLOADS, { recursive: true });
      await generateSampleMedia(filePath);
      const meta = await probeMedia(filePath);
      return sendJson(res, 200, { id, meta });
    }

    // ---- 源视频流（预览/圈定区间用） ----
    if (req.method === 'GET' && url.pathname.startsWith('/api/sources/')) {
      const id = path.basename(url.pathname);
      return sendFile(res, req, path.join(UPLOADS, id), MIME['.mp4']);
    }

    // ---- 提交慢放渲染 ----
    if (req.method === 'POST' && url.pathname === '/api/render') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const { id, inSec, outSec, rate } = body;
      if (!id) return sendJson(res, 400, { error: '缺少视频 id' });
      const inputPath = path.join(UPLOADS, path.basename(id));
      try {
        await fs.access(inputPath);
      } catch {
        return sendJson(res, 404, { error: '源视频不存在，请重新上传' });
      }
      const jobId = crypto.randomUUID();
      const outputName = `${jobId}.mp4`;
      const outputPath = path.join(RESULTS, outputName);
      await fs.mkdir(RESULTS, { recursive: true });
      jobs.set(jobId, { status: 'running', progress: { phase: 'start' } });
      (async () => {
        try {
          const stats = await renderClip({
            inputPath,
            outputPath,
            segments: [{ inSec, outSec, rate }],
            onProgress: (p) => {
              const job = jobs.get(jobId);
              if (job) job.progress = p;
            },
          });
          jobs.set(jobId, {
            status: 'done',
            result: { url: `/api/results/${outputName}`, stats },
          });
        } catch (err) {
          jobs.set(jobId, {
            status: 'error',
            error: err.name === 'ValidationError' ? err.message : `渲染失败: ${err.message}`,
          });
        }
      })();
      return sendJson(res, 202, { jobId });
    }

    // ---- 渲染任务状态 ----
    if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
      const job = jobs.get(path.basename(url.pathname));
      if (!job) return sendJson(res, 404, { error: '任务不存在' });
      return sendJson(res, 200, job);
    }

    // ---- 渲染结果流 ----
    if (req.method === 'GET' && url.pathname.startsWith('/api/results/')) {
      const name = path.basename(url.pathname);
      return sendFile(res, req, path.join(RESULTS, name), MIME['.mp4']);
    }

    sendJson(res, 404, { error: '未知接口' });
  } catch (err) {
    sendJson(res, err.name === 'ValidationError' ? 400 : 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`慢放图形播放器: http://localhost:${PORT}`);
  console.log(`支持速率范围: [${MIN_RATE}, ${MAX_RATE}]，超限将被拒绝`);
});
