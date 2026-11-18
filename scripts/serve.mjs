// Development server for the graphical player and the test bench.
// Serves the app, the test fixtures as demo clips, and a small JSON API so the
// player never needs hard-coded demo data baked into the UI.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoList } from './demos.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (url === '/api/demos') {
    const body = JSON.stringify({ demos: demoList() });
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  if (url === '/' || url === '/src/player' || url === '/src/player/') {
    res.writeHead(302, { Location: '/src/player/index.html' });
    res.end();
    return;
  }

  const rel = url.replace(/^\/+/, '');
  const p = path.join(ROOT, rel);
  if (!p.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = fs.readFileSync(p);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(p)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Accept-Ranges': 'bytes',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

const port = Number(process.env.PORT ?? 5173);
const host = process.env.HOST ?? '127.0.0.1';
server.listen(port, host, () => {
  console.log(`动作慢放播放器: http://${host}:${port}/`);
  console.log(`演示片段: ${demoList().length} 个 (来自 tests/fixtures)`);
});

export { server };
