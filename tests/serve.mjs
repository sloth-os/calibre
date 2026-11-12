#!/usr/bin/env node
/*
 * Minimal static dev server with correct MIME types.
 *
 * worker.js is a MODULE worker importing pyodide.mjs: browsers refuse module
 * scripts served with a non-JavaScript MIME type, and wasm streaming
 * compilation wants application/wasm — python's http.server does not
 * reliably provide either. Zero dependencies.
 *
 * Usage: node tests/serve.mjs [port] [site-dir]
 *   defaults: port 8080, site-dir = repo root (local dev layout: build with
 *   `./patches/build-bundle.sh /path/to/calibre ./wasm` first).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8080);
const ROOT = path.resolve(process.argv[3] || path.resolve(HERE, '..'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

// Production serves the site under the /calibre/ subpath; alias it so local
// dev can exercise the real geometry (relative-URL-only site) by visiting
// http://localhost:PORT/calibre/ — same content as /.
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (rel.startsWith('calibre/')) rel = rel.slice('calibre/'.length);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, '.' + path.sep + rel);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
  });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`serving ${ROOT} at http://localhost:${PORT}/`);
});
