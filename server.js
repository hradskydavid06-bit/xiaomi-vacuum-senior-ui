/**
 * Standalone Local Server (`npm start`)
 * Serves the static frontend (`public/`) and mounts the Firebase Cloud Function
 * (`functions/index.js`) at `/api/vacuum` so the full stack works out of the box.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Load `functions/.env` if present
const envPath = path.join(__dirname, 'functions', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

// Ensure module resolution finds packages installed inside `functions/node_modules`
module.paths.push(path.join(__dirname, 'functions', 'node_modules'));

const { handleVacuumRequest } = require('./functions/index.js');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Route API requests to the Cloud Function handler
  if (pathname === '/api/vacuum') {
    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', async () => {
      req.query = parsedUrl.query || {};
      try {
        req.body = rawBody ? JSON.parse(rawBody) : {};
      } catch (_) {
        req.body = {};
      }

      const expressLikeRes = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          res.writeHead(this.statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(payload));
        },
      };

      await handleVacuumRequest(req, expressLikeRes);
    });
    return;
  }

  // Serve static frontend files from `public/`
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Xiaomi Vacuum Senior UI running at http://localhost:${PORT}`);
});
