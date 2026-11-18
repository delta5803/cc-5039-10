// Shared Playwright harness: serves the repo (with a local sysroot for
// Chromium) and exposes helpers for driving the kernel in a real browser.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoList } from '../scripts/demos.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Playwright snapshots this env var when it is imported, so set it first and
// import afterwards: a repo-local browser install then works with plain
// `npm test`, without the caller exporting anything.
const localBrowsers = path.join(ROOT, '.cache/ms-playwright');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(localBrowsers)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
}
const { chromium } = await import('playwright');

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

export function startServer() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/api/demos') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ demos: demoList() }));
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
      res.writeHead(403);
      res.end();
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
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

export async function launchBrowser(options = {}) {
  // The sandboxed CI image has Chromium's shared libraries extracted into a
  // repo-local sysroot rather than installed system-wide. Use it when present.
  const localSysroot = path.join(ROOT, '.cache/syslibs/root2');
  const sysroot = process.env.SLOWMO_SYSROOT
    ?? (fs.existsSync(localSysroot) ? localSysroot : null);
  const env = { ...process.env };
  if (sysroot) {
    const libs = [
      path.join(sysroot, 'usr/lib/aarch64-linux-gnu'),
      path.join(sysroot, 'lib/aarch64-linux-gnu'),
      path.join(sysroot, 'usr/lib'),
    ].join(':');
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${libs}:${env.LD_LIBRARY_PATH}` : libs;
  }
  env.PLAYWRIGHT_BROWSERS_PATH ??= process.env.PLAYWRIGHT_BROWSERS_PATH;
  // Chromium needs the repo-local sysroot on its own dynamic loader path.
  return chromium.launch({
    channel: 'chromium',
    env,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      ...(options.args ?? []),
    ],
    ...options.launchOptions,
  });
}

export { ROOT };
