// Production server for a VPS: serves the built site (dist/) and the same API router Vercel runs.
// TLS, compression and the apex -> www redirect are done by the reverse proxy in front of it.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 3000);
// A 3 MB file chunk is about 4 MB as base64 JSON; Vercel's own limit is 4.5 MB.
const MAX_BODY_BYTES = 6 * 1024 * 1024;
// Vercel stops the function after 60 s (vercel.json maxDuration).
const REQUEST_TIMEOUT_MS = 65_000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json'
};

// The same headers vercel.json sends, so both hosts behave alike.
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const SECURITY_HEADERS = vercel.headers.find((rule) => rule.source === '/(.*)').headers;

const router = require('../api/router.js');
const sql = require('../api/_db');

class BodyTooLargeError extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Parses the body the way Vercel does for the content types this app sends.
function parseBody(raw, contentType = '') {
  if (!raw.length) return undefined;
  const text = raw.toString('utf8');
  if (contentType.includes('application/json')) return JSON.parse(text);
  if (contentType.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  return text;
}

// The subset of Vercel's response helpers the handlers use.
function vercelResponse(res) {
  return {
    get statusCode() { return res.statusCode; },
    setHeader(name, value) { res.setHeader(name, value); return this; },
    getHeader(name) { return res.getHeader(name); },
    status(code) { res.statusCode = code; return this; },
    json(data) {
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
      return this;
    },
    send(data) {
      if (Buffer.isBuffer(data) || typeof data === 'string') res.end(data);
      else this.json(data);
      return this;
    },
    end(data) { res.end(data); return this; }
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function handleApi(req, res, url) {
  let body;
  try {
    body = parseBody(await readBody(req), req.headers['content-type']);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return sendJson(res, 413, { error: 'So‘rov hajmi juda katta.' });
    return sendJson(res, 400, { error: 'Noto‘g‘ri so‘rov.' });
  }
  const apiReq = {
    url: req.url,
    method: req.method,
    headers: req.headers,
    query: Object.fromEntries(url.searchParams),
    body
  };
  await router(apiReq, vercelResponse(res));
  if (!res.writableEnded) res.end();
}

function isServable(relative) {
  return relative.split(path.sep).every((segment) => segment && !segment.startsWith('.'));
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let relative;
  try {
    relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const file = path.resolve(DIST, relative);
  const stat = file.startsWith(`${DIST}${path.sep}`) && isServable(path.relative(DIST, file))
    ? fs.statSync(file, { throwIfNoEntry: false })
    : undefined;
  if (!stat?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  // Hashed build files never change; everything else is revalidated so a deploy shows at once.
  const cache = url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate';
  const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cache }).end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cache,
    ETag: etag
  });
  if (req.method === 'HEAD') res.end();
  else {
    // A file removed mid-read (a deploy) must end this response, not crash the process.
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
}

async function handleHealth(res) {
  try {
    await sql`SELECT 1`;
    sendJson(res, 200, { ok: true });
  } catch {
    sendJson(res, 503, { ok: false });
  }
}

const server = http.createServer(async (req, res) => {
  for (const { key, value } of SECURITY_HEADERS) res.setHeader(key, value);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return await handleHealth(res);
    // Every /api/<name> goes through the one router, as on Vercel.
    if (/^\/api\/[a-z-]+$/.test(url.pathname)) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'So‘ralgan manzil topilmadi.' });
    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Serverda xatolik yuz berdi.' });
    else res.end();
  }
});

server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = 20_000;
// Longer than the proxy's idle timeout, so the proxy never reuses a connection Node just closed.
server.keepAliveTimeout = 75_000;

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/index.html not found: run `npm run build` first.');
  process.exit(1);
}

server.listen(PORT, () => console.log(`Listening on port ${PORT}`));

function shutdown(signal) {
  console.log(`${signal} received, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
