// LAN server: static files from public/, the API, and a JSON file store in data/.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createApi } from './api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DB = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT) || 5120;
const HOST = process.env.HOST || '0.0.0.0';

mkdirSync(DATA_DIR, { recursive: true });
const map = new Map(existsSync(DB) ? JSON.parse(readFileSync(DB, 'utf8')) : []);

// Write to a temp file then rename, so a crash mid-write never truncates history.
function persist() {
  const tmp = `${DB}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...map]));
  renameSync(tmp, DB);
}

const store = {
  async get(key) { return structuredClone(map.get(key)); },
  async put(key, value) { map.set(key, structuredClone(value)); persist(); },
  async list(prefix) { return [...map].filter(([k]) => k.startsWith(prefix)).map(([, v]) => structuredClone(v)); },
};
const api = createApi(store, readFileSync(path.join(PUBLIC, 'words.txt'), 'utf8'));

// One API request at a time keeps read-modify-write on a match atomic.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
const cache = new Map();

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { return send(res, 400, 'Bad path'); }
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found');
  let entry = cache.get(file);
  if (!entry) {
    let body;
    try { body = await readFile(file); } catch { return send(res, 404, 'Not found'); }
    const ext = path.extname(file);
    entry = { body, gz: ext === '.woff2' ? null : zlib.gzipSync(body), type: TYPES[ext] || 'application/octet-stream', ext };
    cache.set(file, entry);
  }
  const headers = {
    'content-type': entry.type,
    'cache-control': entry.ext === '.woff2' ? 'public, max-age=31536000, immutable'
      : entry.ext === '.txt' ? 'public, max-age=86400' : 'no-cache',
  };
  const gzip = entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (gzip) headers['content-encoding'] = 'gzip';
  res.writeHead(200, headers);
  res.end(gzip ? entry.gz : entry.body);
}

function send(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(text);
}

async function serveApi(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) return send(res, 413, 'Too large');
    chunks.push(chunk);
  }
  const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
    method: req.method,
    headers: Object.fromEntries(['content-type', 'origin'].filter((h) => req.headers[h] !== undefined).map((h) => [h, req.headers[h]])),
    body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
  });
  const response = await serial(() => api(request));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname.startsWith('/api/')) await serveApi(req, res);
    else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, pathname);
    else send(res, 405, 'Method not allowed');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'Server error');
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${PORT}`);
  console.log(`Wordduel on http://localhost:${PORT}`);
  for (const url of lan) console.log(`  phones: ${url}`);
});
